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

function parseCsv(value) {
  if (!value || !value.trim()) {
    return [];
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
  oneBaseUrl:
    process.env.ONE_BASE_URL ||
    'https://intechsys-one-api-b5b5a6cbf9emevev.centralus-01.azurewebsites.net',
  oneAppSlug: process.env.ONE_APP_SLUG || 'zero-touch',
  oneTimeoutMs: Number(process.env.ONE_TIMEOUT_MS || 15000),
  samsungKnoxEnabled: parseBoolean(process.env.SAMSUNG_KNOX_ENABLED, false),
  samsungKnoxBaseUrl:
    process.env.SAMSUNG_KNOX_BASE_URL || 'https://us-kcs-api.samsungknox.com',
  samsungKnoxOAuthTokenUrl:
    process.env.SAMSUNG_KNOX_OAUTH_TOKEN_URL ||
    'https://api.samsungknox.com/ams/v1/oauth2/token',
  samsungKnoxAuthMode: process.env.SAMSUNG_KNOX_AUTH_MODE || 'auto',
  samsungKnoxOAuthScope: process.env.SAMSUNG_KNOX_OAUTH_SCOPE || '',
  samsungKnoxApiToken: process.env.SAMSUNG_KNOX_API_TOKEN || '',
  samsungKnoxClientId: process.env.SAMSUNG_KNOX_CLIENT_ID || '',
  samsungKnoxClientSecret: process.env.SAMSUNG_KNOX_CLIENT_SECRET || '',
  samsungKnoxAccessToken: process.env.SAMSUNG_KNOX_ACCESS_TOKEN || '',
  samsungKnoxClientIdentifier: process.env.SAMSUNG_KNOX_CLIENT_IDENTIFIER || '',
  samsungKnoxKeysJson: process.env.SAMSUNG_KNOX_KEYS_JSON || '',
  samsungKnoxKeysPath: process.env.SAMSUNG_KNOX_KEYS_PATH || '',
  samsungKnoxResellerEmail: process.env.SAMSUNG_KNOX_RESELLER_EMAIL || '',
  samsungKnoxAllowedLoginEmails: parseCsv(
    process.env.SAMSUNG_KNOX_ALLOWED_LOGIN_EMAILS || ''
  ),
  samsungKnoxAllowedCustomerIds: parseCsv(
    process.env.SAMSUNG_KNOX_ALLOWED_CUSTOMER_IDS || ''
  ),
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
  if (!config.oneBaseUrl) {
    throw new Error("Falta 'ONE_BASE_URL'. Sin One no hay forma de autenticar usuarios en producción.");
  }
}

module.exports = { config };
