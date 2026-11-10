const { requireAuth: requireOneAuth } = require('./one-auth.middleware');
const { requireApiKeyOrIntegration } = require('./api-key.middleware');

/**
 * Middleware híbrido de autenticación:
 * - Si vienen credenciales de integración (X-Api-Key / X-Api-Secret) o API Key, valida contra One o BD local.
 * - Si viene Authorization: Bearer, valida el token del usuario en One.
 */
async function requireAuth(req, res, next) {
  if (req.headers['x-api-key'] || req.query?.apiKey) {
    return requireApiKeyOrIntegration(req, res, next);
  }
  return requireOneAuth(req, res, next);
}

module.exports = { requireAuth };

