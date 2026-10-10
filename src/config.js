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

// Consolas que llaman a este API desde el navegador cuando CORS_ORIGIN no viene definido en
// producción: la consola de producción, la de desarrollo, el portal de One y la consola local.
const ORIGENES_PRODUCCION = [
  'https://happy-desert-04a62e310.3.azurestaticapps.net',
  'https://witty-mushroom-070e3901e.6.azurestaticapps.net',
  'https://jolly-pond-0e51aed10.3.azurestaticapps.net',
  'http://localhost:5173',
];

function parseCsv(value) {
  if (!value || !value.trim()) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || 'development';

const config = {
  nodeEnv,
  port: Number(process.env.PORT || 8080),
  jwtSecret: process.env.JWT_SECRET || 'change_this_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  // SQL Server. Los valores por defecto son los de producción (Azure SQL Database); en local se
  // apunta a otra base con DB_SERVER/DB_NAME/DB_USER/DB_PASSWORD en el .env, o con
  // DB_CONNECTION_STRING ("Server=...;Database=...;User Id=...;Password=...;Encrypt=true"),
  // que tiene prioridad sobre todo lo demás.
  db: {
    connectionString: process.env.DB_CONNECTION_STRING || '',
    server: process.env.DB_SERVER || 'sql-zerotouch-prd-01.database.windows.net',
    port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_NAME || 'ZeroTouch',
    user: process.env.DB_USER || 'ZeroTouchUserAdmin',
    password: process.env.DB_PASSWORD || 'jt$67ka#4lado@',
    encrypt: parseBoolean(process.env.DB_ENCRYPT, true),
    trustServerCertificate: parseBoolean(process.env.DB_TRUST_SERVER_CERTIFICATE, false),
    // Azure SQL serverless puede tardar en despertar: se le da tiempo a la primera conexión.
    connectionTimeoutMs: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 60000),
    requestTimeoutMs: Number(process.env.DB_REQUEST_TIMEOUT_MS || 30000),
  },
  zeroTouchBaseUrl:
    process.env.ZERO_TOUCH_BASE_URL || 'https://androiddeviceprovisioning.googleapis.com/v1',
  zeroTouchPartnerId: process.env.ZERO_TOUCH_PARTNER_ID || '1450835637',
  corsOrigins: parseCorsOrigins(
    process.env.CORS_ORIGIN || (nodeEnv === 'production' ? ORIGENES_PRODUCCION.join(',') : '*')
  ),
  trustProxy: parseBoolean(process.env.TRUST_PROXY, true),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX || 300),
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  demoZeroTouchCustomerId: process.env.DEMO_ZERO_TOUCH_CUSTOMER_ID || '1791589702',
  oneBaseUrl:
    process.env.ONE_BASE_URL ||
    'https://app-intechsysone-api-prd-bxehhkf8dgcwbve9.centralus-01.azurewebsites.net',
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

// Los tokens los emite y valida One (JWT_SECRET ya no firma nada) y la base de datos y el Partner
// ID tienen valores de producción por defecto: solo se valida lo que no puede faltar.
if (config.nodeEnv === 'production') {
  if (!config.zeroTouchPartnerId) {
    throw new Error('ZERO_TOUCH_PARTNER_ID must be set in production.');
  }
  if (!config.db.connectionString && (!config.db.server || !config.db.database)) {
    throw new Error('Falta la base de datos: defina DB_SERVER y DB_NAME (o DB_CONNECTION_STRING).');
  }
  if (!config.oneBaseUrl) {
    throw new Error("Falta 'ONE_BASE_URL'. Sin One no hay forma de autenticar usuarios en producción.");
  }
}

module.exports = { config };
