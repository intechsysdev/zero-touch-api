const { requireAuth } = require('./one-auth.middleware');
const { resolveTenant, requireTenant } = require('./tenant.middleware');
const {
  requireApiKeyOrIntegration,
  timingSafeEqualStr,
} = require('./api-key.middleware');
const {
  generalLimiter,
  authLimiter,
  devicesLimiter,
} = require('./rate-limiter.middleware');

module.exports = {
  requireAuth,
  resolveTenant,
  requireTenant,
  requireApiKeyOrIntegration,
  timingSafeEqualStr,
  generalLimiter,
  authLimiter,
  devicesLimiter,
};

