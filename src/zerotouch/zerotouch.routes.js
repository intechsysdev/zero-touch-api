const express = require('express');
const { z } = require('zod');
const {
  listCustomers,
  listConfigurations,
  claimDevice,
  unclaimDevice,
} = require('./zerotouch.client');
const { pool, writeAuditLog, getClientByDbId, listClientDevices } = require('../db');
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
        await pool.query(
          'UPDATE clients SET zero_touch_customer_name = $1 WHERE id = $2',
          [customerName, client.id]
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

    await pool.query(
      'UPDATE clients SET zero_touch_customer_name = $1 WHERE id = $2',
      [customerName, clientDbId]
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

    const data = await claimDevice({
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
        const claimResponse = await claimDevice({
          customerId,
          deviceIdentifier: identifier,
          configurationId: itemConfigurationId,
        });

        results.push({
          index,
          status: 'claimed',
          deviceIdentifier: buildIdentifierPreview(identifier),
          configurationId: itemConfigurationId || null,
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

    const data = await unclaimDevice({
      deviceIdentifier,
    });

    const customerId = await resolveCustomerIdFromAuth(req);
    await syncClientDevices({
      clientDbId: Number(req.auth.clientDbId),
      customerId,
    });

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'zerotouch.devices.unclaim',
      payload: { deviceIdentifier },
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
