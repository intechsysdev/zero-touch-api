const express = require('express');
const { z } = require('zod');
const {
  listCustomers,
  listConfigurations,
  claimDevice,
  applyConfiguration,
  findDevicesByIdentifier,
  unclaimDevice,
} = require('./zerotouch.client');
const { query, writeAuditLog, getClientByDbId, listClientDevices } = require('../db');
const { syncClientDevices } = require('./zerotouch.sync');
const { devicesLimiter } = require('../middleware');
const { getCompanyDynamicConfig } = require('../one');

const router = express.Router();

function normalizeDeviceIdentifier(identifier = {}) {
  const normalized = {
    imei: identifier.imei?.trim(),
    serialNumber: identifier.serialNumber?.trim(),
    manufacturer: identifier.manufacturer?.trim(),
    model: identifier.model?.trim(),
  };

  if (!normalized.imei && normalized.serialNumber && /^\d{15}$/.test(normalized.serialNumber)) {
    normalized.imei = normalized.serialNumber;
    normalized.serialNumber = undefined;
  }

  if (!normalized.imei && !normalized.serialNumber) {
    const error = new Error('imei or serialNumber is required in deviceIdentifier.');
    error.statusCode = 400;
    throw error;
  }

  // Google identifica un serial junto con su fabricante (y modelo): solo no basta.
  if (!normalized.imei && !normalized.manufacturer) {
    const error = new Error('Para identificar el equipo por serial indique también el fabricante y el modelo.');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function maybeTranslateIdentifierError(error) {
  const customCode =
    error?.details?.error?.details?.[0]?.code ||
    error?.details?.details?.[0]?.code;

  if (customCode === 'INVALID_IDENTIFIER_SET') {
    error.message =
      'Identificador invalido. Usa IMEI de 15 digitos o combina serialNumber con manufacturer y model.';
  }
}

/** El reclamo de Zero-touch de este cliente sobre el equipo, si lo tiene. */
function reclamoDelCliente(device, customerId) {
  return (device.claims || []).find(
    (c) =>
      String(c.ownerCompanyId || '') === String(customerId) &&
      (!c.sectionType || c.sectionType === 'SECTION_TYPE_ZERO_TOUCH')
  );
}

/**
 * El equipo con ese identificador, solo si es de este cliente. Google lo busca entre todos los
 * del reseller: sin este filtro un cliente vería (o liberaría) equipos de otro.
 */
async function buscarEquipoDelCliente(customerId, deviceIdentifier) {
  const data = await findDevicesByIdentifier({ deviceIdentifier, limit: 10 });
  const devices = Array.isArray(data.devices) ? data.devices : [];
  return devices.find((d) => reclamoDelCliente(d, customerId)) || null;
}

/** Lo que se devuelve de un equipo: sus identificadores, la configuración y el reclamo. */
function resumenEquipo(device, customerId) {
  const id = device.deviceIdentifier || {};
  const reclamo = reclamoDelCliente(device, customerId) || {};
  return {
    deviceId: device.deviceId,
    name: device.name,
    imei: id.imei || null,
    serialNumber: id.serialNumber || null,
    manufacturer: id.manufacturer || null,
    model: id.model || null,
    configuration: device.configuration || null,
    ownerCompanyId: reclamo.ownerCompanyId || null,
    resellerId: reclamo.resellerId || null,
    sectionType: reclamo.sectionType || null,
  };
}

/** Identificador de un equipo desde la consulta (?imei= o ?serialNumber=&manufacturer=&model=). */
function identificadorDeConsulta(query) {
  return normalizeDeviceIdentifier({
    imei: query.imei ? String(query.imei) : undefined,
    serialNumber: query.serialNumber ? String(query.serialNumber) : undefined,
    manufacturer: query.manufacturer ? String(query.manufacturer) : undefined,
    model: query.model ? String(query.model) : undefined,
  });
}

/**
 * Reclama y, si se pidió, le aplica la configuración. La configuración va aparte porque la API de
 * partner no la acepta en el reclamo; si falla, el equipo queda reclamado y se dice por qué.
 */
async function reclamar({ customerId, deviceIdentifier, configurationId }) {
  const claim = await claimDevice({ customerId, deviceIdentifier });
  let configuracion = null;

  if (configurationId) {
    try {
      await applyConfiguration({ customerId, deviceId: claim.deviceId, configurationId });
      configuracion = { aplicada: true, configurationId };
    } catch (error) {
      configuracion = { aplicada: false, configurationId, error: error.message };
    }
  }

  return { ...claim, configuracion };
}

function buildIdentifierPreview(identifier) {
  if (identifier.imei) {
    return { imei: identifier.imei };
  }

  return {
    serialNumber: identifier.serialNumber,
    manufacturer: identifier.manufacturer,
    model: identifier.model,
  };
}

/**
 * Customer de Zero-touch de la empresa con la que entró el usuario. Sale de la empresa, nunca de
 * la petición: si se aceptara uno que mande el navegador, cualquiera podría ver o reclamar
 * equipos de otro cliente.
 *
 * 1. El que se encontró en Google con el Client ID de la empresa (coincidencia exacta).
 * 2. Si no, ZERO_TOUCH_CUSTOMER_ID de la configuración de la empresa en One (lo fija un
 *    administrador, para clientes cuyo Customer ID no es su Client ID).
 */
async function resolveCustomerIdFromAuth(req) {
  const clientDbId = Number(req.auth.clientDbId);
  const client = await getClientByDbId(clientDbId);

  if (!client || !client.is_active) {
    const error = new Error('Cliente inactivo o no encontrado.');
    error.statusCode = 403;
    throw error;
  }

  let customerName = client.zero_touch_customer_name || '';

  if (!customerName) {
    try {
      const dynamicConfig = await getCompanyDynamicConfig(client.id);
      if (dynamicConfig?.zeroTouchCustomerName) {
        customerName = dynamicConfig.zeroTouchCustomerName;
        await query(
          'UPDATE clients SET zero_touch_customer_name = @customerName WHERE id = @id',
          { customerName, id: String(client.id) }
        ).catch(() => {});
      }
    } catch (configError) {
      console.warn('No se pudo obtener config de One:', configError.message);
    }
  }

  const customerId = String(customerName).split('/').pop();
  if (!customerId) {
    const error = new Error(
      `El Client ID ${client.client_id} de "${client.company_name}" no existe en Zero-touch. Revise la variable de la empresa en One.`
    );
    error.statusCode = 400;
    throw error;
  }

  return customerId;
}

/** Vincular empresas con clientes o listar los clientes del reseller es cosa de la plataforma. */
function soloPlataforma(req, res, next) {
  if (req.user?.isPlatformAdmin) return next();
  return res.status(403).json({ message: 'Solo un administrador de la plataforma puede hacer esto.' });
}

/**
 * Endpoint para vincular o actualizar el Zero Touch Customer ID de una empresa
 * PUT /zerotouch/customers/link
 * Body: { customerId: "1791589702" } o { customerName: "customers/1791589702" }
 */
router.put('/customers/link', soloPlataforma, async (req, res, next) => {
  try {
    const schema = z.object({
      customerId: z.union([z.string(), z.number()]),
    });
    const body = schema.parse(req.body);
    const rawId = String(body.customerId).trim().split('/').pop();
    const customerName = `customers/${rawId}`;
    const clientDbId = Number(req.auth.clientDbId);

    await query(
      'UPDATE clients SET zero_touch_customer_name = @customerName WHERE id = @id',
      { customerName, id: clientDbId }
    );

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId,
      action: 'zerotouch.customers.link',
      payload: { zeroTouchCustomerName: customerName, rawId },
    });

    res.json({
      ok: true,
      clientDbId,
      customerId: rawId,
      zeroTouchCustomerName: customerName,
      message: `Empresa vinculada exitosamente con Customer ID ${rawId}`,
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    }
    next(error);
  }
});

router.get('/customers', soloPlataforma, async (req, res, next) => {
  try {
    const data = await listCustomers();
    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.customers.list',
      payload: {},
    });
    res.json(data);
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    }
    next(error);
  }
});

router.get('/configurations', async (req, res, next) => {
  try {
    const schema = z.object({
      customerId: z.string().optional(),
    });
    const query = schema.parse(req.query);

    const customerId = await resolveCustomerIdFromAuth(req);
    if (query.customerId && query.customerId !== customerId) {
      const error = new Error('customerId no autorizado para este cliente.');
      error.statusCode = 403;
      throw error;
    }

    const data = await listConfigurations({ customerId });
    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.configurations.list',
      payload: { customerId },
    });

    res.json(data);
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    }
    next(error);
  }
});

router.post('/configurations', async (req, res) => {
  writeAuditLog({
    userId: Number(req.auth.sub),
    clientDbId: Number(req.auth.clientDbId),
    action: 'zerotouch.configurations.create.blocked',
    payload: { reason: 'read-only endpoint' },
  }).catch(() => {});

  res.status(405).json({
    message: 'Operación no permitida. Las configuraciones son solo lectura.',
  });
});

router.delete('/configurations/:configurationId', async (req, res) => {
  writeAuditLog({
    userId: Number(req.auth.sub),
    clientDbId: Number(req.auth.clientDbId),
    action: 'zerotouch.configurations.delete.blocked',
    payload: { reason: 'read-only endpoint' },
  }).catch(() => {});

  res.status(405).json({
    message: 'Operación no permitida. Las configuraciones son solo lectura.',
  });
});

router.get('/devices', async (req, res, next) => {
  try {
    const schema = z.object({
      customerId: z.string().optional(),
      forceSync: z.string().optional(),
    });

    const query = schema.parse(req.query);
    const customerId = await resolveCustomerIdFromAuth(req);
    if (query.customerId && query.customerId !== customerId) {
      const error = new Error('customerId no autorizado para este cliente.');
      error.statusCode = 403;
      throw error;
    }

    if (String(query.forceSync || '').toLowerCase() === 'true') {
      await syncClientDevices({
        clientDbId: Number(req.auth.clientDbId),
        customerId,
      });
    }

    const rows = await listClientDevices(Number(req.auth.clientDbId));
    const devices = rows.map((item) => item.raw_payload_json);

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.devices.list',
      payload: { customerId, from: 'db-cache', count: devices.length },
    });

    res.json({ devices });
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    }
    next(error);
  }
});

/**
 * Consulta de un equipo por IMEI (?imei=) o serial (?serialNumber=&manufacturer=&model=),
 * directo en Zero-touch. Solo responde si el equipo es de este cliente: uno de otro cliente sale
 * igual que uno que no existe, para no revelar de quién es.
 */
router.get('/devices/buscar', async (req, res, next) => {
  try {
    const deviceIdentifier = identificadorDeConsulta(req.query || {});
    const customerId = await resolveCustomerIdFromAuth(req);
    const device = await buscarEquipoDelCliente(customerId, deviceIdentifier);

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.devices.search',
      payload: { customerId, deviceIdentifier, encontrado: Boolean(device) },
    });

    if (!device) {
      return res.status(404).json({ message: 'No hay un equipo con ese identificador en Zero-touch para su empresa.' });
    }

    res.json({ device: resumenEquipo(device, customerId), raw: device });
  } catch (error) {
    maybeTranslateIdentifierError(error);
    next(error);
  }
});

router.get('/devices/identifier-options', async (req, res, next) => {
  try {
    const schema = z.object({
      forceSync: z.string().optional(),
    });
    const query = schema.parse(req.query);

    const customerId = await resolveCustomerIdFromAuth(req);

    if (String(query.forceSync || '').toLowerCase() === 'true') {
      await syncClientDevices({
        clientDbId: Number(req.auth.clientDbId),
        customerId,
      });
    }

    const rows = await listClientDevices(Number(req.auth.clientDbId));
    const devices = rows.map((item) => item.raw_payload_json || {});

    const manufacturersSet = new Set();
    const modelsByManufacturer = {};

    for (const item of devices) {
      const identifier = item.deviceIdentifier || {};
      const manufacturer = String(
        item.manufacturer || identifier.manufacturer || ''
      ).trim();
      const model = String(item.model || identifier.model || '').trim();

      if (!manufacturer) {
        continue;
      }

      manufacturersSet.add(manufacturer);
      if (!modelsByManufacturer[manufacturer]) {
        modelsByManufacturer[manufacturer] = new Set();
      }
      if (model) {
        modelsByManufacturer[manufacturer].add(model);
      }
    }

    const manufacturers = Array.from(manufacturersSet).sort((a, b) =>
      a.localeCompare(b)
    );

    const normalizedModelsByManufacturer = {};
    for (const manufacturer of manufacturers) {
      normalizedModelsByManufacturer[manufacturer] = Array.from(
        modelsByManufacturer[manufacturer] || []
      ).sort((a, b) => a.localeCompare(b));
    }

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.devices.identifierOptions.list',
      payload: {
        customerId,
        manufacturersCount: manufacturers.length,
      },
    });

    res.json({
      customerId,
      manufacturers,
      modelsByManufacturer: normalizedModelsByManufacturer,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/devices/claim', devicesLimiter, async (req, res, next) => {
  try {
    const schema = z.object({
      customerId: z.string().optional(),
      deviceIdentifier: z.object({
        imei: z.string().optional(),
        serialNumber: z.string().optional(),
        manufacturer: z.string().optional(),
        model: z.string().optional(),
      }),
      configurationId: z.union([z.string(), z.number()]).optional(),
    });
    const body = schema.parse(req.body);
    const customerId = await resolveCustomerIdFromAuth(req);
    if (body.customerId && body.customerId !== customerId) {
      const error = new Error('customerId no autorizado para este cliente.');
      error.statusCode = 403;
      throw error;
    }

    const deviceIdentifier = normalizeDeviceIdentifier(body.deviceIdentifier);
    const configurationId =
      body.configurationId === undefined || body.configurationId === null
        ? undefined
        : String(body.configurationId).trim();

    if (configurationId === '') {
      const error = new Error('configurationId no puede ser vacio cuando se envia.');
      error.statusCode = 400;
      throw error;
    }

    const data = await reclamar({
      customerId,
      deviceIdentifier,
      configurationId,
    });

    await syncClientDevices({
      clientDbId: Number(req.auth.clientDbId),
      customerId,
    });

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.devices.claim',
      payload: { customerId, configurationId: configurationId || null, deviceIdentifier },
    });

    res.status(201).json(data);
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    } else {
      maybeTranslateIdentifierError(error);
    }
    next(error);
  }
});

router.post('/devices/claim/bulk', devicesLimiter, async (req, res, next) => {
  try {
    const schema = z.object({
      customerId: z.string().optional(),
      identifierType: z.enum(['imei', 'serial']),
      configurationId: z.union([z.string(), z.number()]).optional(),
      devices: z
        .array(
          z.object({
            imei: z.string().optional(),
            serialNumber: z.string().optional(),
            manufacturer: z.string().optional(),
            model: z.string().optional(),
            configurationId: z.union([z.string(), z.number()]).optional(),
          })
        )
        .min(1),
    });

    const body = schema.parse(req.body);
    const customerId = await resolveCustomerIdFromAuth(req);
    if (body.customerId && body.customerId !== customerId) {
      const error = new Error('customerId no autorizado para este cliente.');
      error.statusCode = 403;
      throw error;
    }

    const defaultConfigurationId =
      body.configurationId === undefined || body.configurationId === null
        ? undefined
        : String(body.configurationId).trim();

    if (defaultConfigurationId === '') {
      const error = new Error('configurationId no puede ser vacio cuando se envia.');
      error.statusCode = 400;
      throw error;
    }

    const results = [];

    for (let index = 0; index < body.devices.length; index += 1) {
      const rawDevice = body.devices[index];

      const normalizedForType =
        body.identifierType === 'imei'
          ? { imei: rawDevice.imei?.trim() }
          : {
              serialNumber: rawDevice.serialNumber?.trim(),
              manufacturer: rawDevice.manufacturer?.trim(),
              model: rawDevice.model?.trim(),
            };

      const identifier = normalizeDeviceIdentifier(normalizedForType);
      const itemConfigurationId =
        rawDevice.configurationId === undefined || rawDevice.configurationId === null
          ? defaultConfigurationId
          : String(rawDevice.configurationId).trim();

      if (itemConfigurationId === '') {
        const error = new Error('configurationId no puede ser vacio cuando se envia.');
        error.statusCode = 400;
        throw error;
      }

      try {
        const claimResponse = await reclamar({
          customerId,
          deviceIdentifier: identifier,
          configurationId: itemConfigurationId,
        });

        results.push({
          index,
          status: 'claimed',
          deviceIdentifier: buildIdentifierPreview(identifier),
          configurationId: itemConfigurationId || null,
          configuracion: claimResponse.configuracion,
          response: claimResponse,
        });
      } catch (error) {
        maybeTranslateIdentifierError(error);
        results.push({
          index,
          status: 'failed',
          deviceIdentifier: buildIdentifierPreview(identifier),
          configurationId: itemConfigurationId || null,
          error: {
            message: error.message,
            statusCode: error.statusCode || 500,
            details: error.details || null,
          },
        });
      }
    }

    await syncClientDevices({
      clientDbId: Number(req.auth.clientDbId),
      customerId,
    });

    const successCount = results.filter((item) => item.status === 'claimed').length;
    const failedCount = results.length - successCount;

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.devices.claim.bulk',
      payload: {
        customerId,
        identifierType: body.identifierType,
        total: results.length,
        successCount,
        failedCount,
      },
    });

    const statusCode = failedCount > 0 && successCount > 0 ? 207 : 200;
    res.status(statusCode).json({
      customerId,
      identifierType: body.identifierType,
      summary: {
        total: results.length,
        successCount,
        failedCount,
      },
      results,
    });
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    }
    next(error);
  }
});

router.post('/devices/unclaim', devicesLimiter, async (req, res, next) => {
  try {
    const schema = z.object({
      deviceIdentifier: z.object({
        imei: z.string().optional(),
        serialNumber: z.string().optional(),
        manufacturer: z.string().optional(),
        model: z.string().optional(),
      }),
    });
    const body = schema.parse(req.body);
    const deviceIdentifier = normalizeDeviceIdentifier(body.deviceIdentifier);
    const customerId = await resolveCustomerIdFromAuth(req);

    // Google libera el equipo sea de quien sea: sin esta comprobación un cliente podría sacar de
    // Zero-touch los equipos de otro con solo conocer su IMEI.
    const device = await buscarEquipoDelCliente(customerId, deviceIdentifier);
    if (!device) {
      const error = new Error('No hay un equipo con ese identificador en Zero-touch para su empresa.');
      error.statusCode = 404;
      throw error;
    }

    const data = await unclaimDevice({ deviceId: device.deviceId });

    await syncClientDevices({
      clientDbId: Number(req.auth.clientDbId),
      customerId,
    });

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.devices.unclaim',
      payload: { customerId, deviceId: device.deviceId, deviceIdentifier },
    });

    res.json(data);
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    } else {
      maybeTranslateIdentifierError(error);
    }
    next(error);
  }
});

module.exports = { zeroTouchRouter: router };
