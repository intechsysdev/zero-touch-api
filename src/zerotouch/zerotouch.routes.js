const express = require('express');
const { z } = require('zod');
const {
  listCustomers,
  listConfigurations,
  claimDevice,
  unclaimDevice,
} = require('./zerotouch.client');
const { writeAuditLog, getClientByDbId, listClientDevices } = require('../db');
const { syncClientDevices } = require('./zerotouch.sync');

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

async function resolveCustomerIdFromAuth(req) {
  const clientDbId = Number(req.auth.clientDbId);
  const client = await getClientByDbId(clientDbId);

  if (!client || !client.is_active) {
    const error = new Error('Cliente inactivo o no encontrado.');
    error.statusCode = 403;
    throw error;
  }

  const customerName = client.zero_touch_customer_name || '';
  const customerId = String(customerName).split('/').pop();
  if (!customerId) {
    const error = new Error(
      'Cliente sin zero_touch_customer_name configurado. Contacta al administrador.'
    );
    error.statusCode = 400;
    throw error;
  }

  return customerId;
}

router.get('/customers', async (req, res, next) => {
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

router.post('/devices/claim', async (req, res, next) => {
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

router.post('/devices/claim/bulk', async (req, res, next) => {
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

router.post('/devices/unclaim', async (req, res, next) => {
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
