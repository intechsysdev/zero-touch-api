require('dotenv').config();

const ONE_DEFAULT_BASE_URL =
  'https://app-intechsysone-api-prd-bxehhkf8dgcwbve9.centralus-01.azurewebsites.net';
const ONE_DEFAULT_APP_SLUG = 'zero-touch';

const oneConfig = {
  baseUrl: (process.env.ONE_BASE_URL || ONE_DEFAULT_BASE_URL).replace(/\/+$/, ''),
  appSlug: process.env.ONE_APP_SLUG || ONE_DEFAULT_APP_SLUG,
  timeoutMs: Number(process.env.ONE_TIMEOUT_MS || 15000),
  isConfigured: () => Boolean(oneConfig.baseUrl),
  constants: {
    claimTenant: 'tenant',          // Formato: "{tenantId}:{rol}"
    rolPlataforma: 'PlatformAdmin', // Rol transversal superadministrador
    cabeceraTenant: 'X-Tenant-Id',  // Cabecera enviada por el frontend
  },
};

module.exports = { oneConfig };

