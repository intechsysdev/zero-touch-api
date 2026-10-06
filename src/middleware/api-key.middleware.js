const crypto = require('crypto');
const { config } = require('../config');
const { verifyIntegrationCredentials } = require('../one');
const { sha256 } = require('../one/one.cache');
const { getClientByOneTenantId, getClientBySlug, getClientByApiKeyHash } = require('../db');

/**
 * Comparación segura contra ataques de temporización (timing attacks).
 * Equivalente a CryptographicOperations.FixedTimeEquals en .NET.
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware de Autenticación por API Key / Integración.
 * Equivalente a ApiKeyAttribute.cs y CredencialesOne.cs en .NET.
 *
 * Soporta:
 * 1. X-Api-Key + X-Api-Secret -> Integración externa validada en One (/api/v1/integration/verify)
 * 2. X-Api-Key solo:
 *    - Si coincide con ApiKeyAdministrador -> SuperAdmin transversal
 *    - Si no -> Búsqueda SHA256(key) en tabla clients (api_key_hash)
 */
async function requireApiKeyOrIntegration(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query?.apiKey;
  const apiSecret = req.headers['x-api-secret'];

  if (!apiKey) {
    return res.status(401).json({ message: 'Cabecera X-Api-Key requerida.' });
  }

  // 1. Caso: Credenciales de Integración Externa (Key + Secret hacia One)
  if (apiKey && apiSecret) {
    try {
      const integration = await verifyIntegrationCredentials(apiKey, apiSecret);

      let client = await getClientByOneTenantId(integration.tenantId);
      if (!client && integration.tenantSlug) {
        client = await getClientBySlug(integration.tenantSlug);
      }

      req.auth = {
        authType: 'integration',
        tenantId: integration.tenantId,
        clientDbId: client?.id || null,
        clientId: client?.client_id || null,
      };

      if (client) {
        req.tenant = {
          id: client.id,
          clientDbId: client.id,
          clientId: client.client_id,
          companyName: client.company_name,
          oneTenantId: client.one_tenant_id,
          oneSlug: client.one_slug,
          zeroTouchCustomerName: client.zero_touch_customer_name,
        };
      }

      return next();
    } catch (error) {
      const status = error.statusCode || 401;
      return res.status(status).json({ message: error.message, details: error.details });
    }
  }

  // 2. Caso: Llave de Administrador Maestro (SuperAdmin)
  const adminKey = process.env.API_KEY_ADMINISTRADOR || config.apiKeyAdmin || '';
  if (adminKey && timingSafeEqualStr(apiKey, adminKey)) {
    req.auth = {
      authType: 'admin',
      isSuperAdmin: true,
      role: 'PlatformAdmin',
    };
    return next();
  }

  // 3. Caso: Llave de Dispositivo o Empresa Local (SHA-256 en BD)
  try {
    const keyHash = sha256(apiKey);
    const client = await getClientByApiKeyHash(keyHash);

    if (!client) {
      return res.status(401).json({ message: 'API Key no válida o revocada.' });
    }

    req.auth = {
      authType: 'device',
      clientDbId: client.id,
      clientId: client.client_id,
    };

    req.tenant = {
      id: client.id,
      clientDbId: client.id,
      clientId: client.client_id,
      companyName: client.company_name,
      oneTenantId: client.one_tenant_id,
      oneSlug: client.one_slug,
      zeroTouchCustomerName: client.zero_touch_customer_name,
    };

    return next();
  } catch (error) {
    return res.status(500).json({ message: 'Error validando API Key.' });
  }
}

module.exports = {
  requireApiKeyOrIntegration,
  timingSafeEqualStr,
};

