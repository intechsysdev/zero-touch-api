const express = require('express');
const { z } = require('zod');
const {
  listSamsungDevices,
  uploadSamsungDevices,
  deleteSamsungDevices,
} = require('./samsung.client');
const { writeAuditLog } = require('../db');

const router = express.Router();

function resolveSamsungCustomerIdFromAuth(req, requestedCustomerId) {
  const authCustomerId = String(req.auth.samsungCustomerId || '').trim();

  if (!authCustomerId) {
    const error = new Error('Este usuario no tiene Samsung Knox habilitado.');
    error.statusCode = 403;
    throw error;
  }

  if (requestedCustomerId && String(requestedCustomerId).trim() !== authCustomerId) {
    const error = new Error('customerId no autorizado para este cliente.');
    error.statusCode = 403;
    throw error;
  }

  return authCustomerId;
}

router.get('/devices', async (req, res, next) => {
  try {
    const querySchema = z.object({
      customerId: z.string().optional(),
    });
    const query = querySchema.parse(req.query);
    const customerId = resolveSamsungCustomerIdFromAuth(req, query.customerId);

    const data = await listSamsungDevices({ customerId });

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'samsung.devices.list',
      payload: { customerId, count: data.devices.length },
    });

    res.json({ customerId, devices: data.devices });
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    }
    next(error);
  }
});

router.post('/devices/claim/bulk', async (req, res, next) => {
  try {
    const bodySchema = z.object({
      customerId: z.string().optional(),
      profileId: z.union([z.string(), z.number()]),
      devices: z
        .array(
          z.object({
            imei: z.string().optional(),
            meidImei: z.string().optional(),
          })
        )
        .min(1),
    });

    const body = bodySchema.parse(req.body);
    const customerId = resolveSamsungCustomerIdFromAuth(req, body.customerId);

    const mappedDevices = body.devices
      .map((item) => String(item.meidImei || item.imei || '').trim())
      .filter(Boolean)
      .map((meidImei) => ({ meidImei }));

    if (mappedDevices.length === 0) {
      const error = new Error('Debes enviar al menos un IMEI Samsung valido.');
      error.statusCode = 400;
      throw error;
    }

    const response = await uploadSamsungDevices({
      customerId,
      profileId: String(body.profileId).trim(),
      devices: mappedDevices,
    });

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'samsung.devices.claim.bulk',
      payload: {
        customerId,
        profileId: String(body.profileId).trim(),
        total: mappedDevices.length,
      },
    });

    res.status(201).json({
      customerId,
      summary: {
        total: mappedDevices.length,
        successCount: mappedDevices.length,
        failedCount: 0,
      },
      response,
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
    const bodySchema = z.object({
      deviceIds: z.array(z.string()).optional(),
      deviceIdentifier: z
        .object({
          imei: z.string().optional(),
          serialNumber: z.string().optional(),
        })
        .optional(),
    });
    const body = bodySchema.parse(req.body);

    const customerId = resolveSamsungCustomerIdFromAuth(req);

    const fromArray = (body.deviceIds || []).map((item) => item.trim()).filter(Boolean);
    const fromIdentifier = [
      String(body.deviceIdentifier?.imei || '').trim(),
      String(body.deviceIdentifier?.serialNumber || '').trim(),
    ].filter(Boolean);

    const deviceIds = [...new Set([...fromArray, ...fromIdentifier])];

    if (deviceIds.length === 0) {
      const error = new Error('Debes enviar al menos un deviceId/imei para eliminar.');
      error.statusCode = 400;
      throw error;
    }

    const response = await deleteSamsungDevices({ customerId, deviceIds });

    await writeAuditLog({
      userId: Number(req.auth.sub),
      clientDbId: Number(req.auth.clientDbId),
      action: 'samsung.devices.unclaim',
      payload: { count: deviceIds.length },
    });

    res.json({ deleted: deviceIds.length, response });
  } catch (error) {
    if (error.name === 'ZodError') {
      error.statusCode = 400;
      error.message = error.issues.map((item) => item.message).join(', ');
    }
    next(error);
  }
});

module.exports = { samsungRouter: router };
