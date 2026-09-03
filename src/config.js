require('dotenv').config();

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value).toLowerCase() === 'true';
}

function parseCorsOrigins(value) {
  if (!value || value.trim() === '*') {
    return ['*'];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8080),
  jwtSecret: process.env.JWT_SECRET || 'change_this_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  dbUrl: process.env.DB_URL || 'postgres://postgres:postgres@localhost:5432/intechsys_zt',
  zeroTouchBaseUrl:
    process.env.ZERO_TOUCH_BASE_URL || 'https://androiddeviceprovisioning.googleapis.com/v1',
  zeroTouchPartnerId: process.env.ZERO_TOUCH_PARTNER_ID || '1450835637',
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGIN || '*'),
  trustProxy: parseBoolean(process.env.TRUST_PROXY, true),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX || 300),
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  demoZeroTouchCustomerId: process.env.DEMO_ZERO_TOUCH_CUSTOMER_ID || '1791589702',
};

if (config.nodeEnv === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change_this_secret') {
    throw new Error('JWT_SECRET must be set to a secure value in production.');
  }
  if (!process.env.DB_URL) {
    throw new Error('DB_URL must be set in production.');
  }
  if (!process.env.ZERO_TOUCH_PARTNER_ID) {
    throw new Error('ZERO_TOUCH_PARTNER_ID must be set in production.');
  }
}

module.exports = { config };
