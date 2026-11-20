const { listUserAppTenants, getTenantAppSettingsWithUserToken } = require('./one.client');
const { syncOneTenants } = require('../db');

/**
 * Equivalente a EmpresasOne.cs en .NET.
 * Obtiene los tenants asignados al usuario en One para la app "zero-touch"
 * y sincroniza la base de datos local (auto-provisión de empresas).
 */
async function syncUserTenants(token) {
  if (!token) {
    throw new Error('Token requerido para sincronizar tenants con One.');
  }

  // 1. Consultar a One: GET api/v1/me/apps/zero-touch/tenants
  const tenantsFromOne = await listUserAppTenants(token);

  // 2. Para cada empresa, consultar sus variables y configuraciones en One
  // (incluyendo SAMSUNG_KNOX_CUSTOMER_ID descifrado)
  for (const t of tenantsFromOne) {
    if (t.tenantId) {
      try {
        const settings = await getTenantAppSettingsWithUserToken(token, t.tenantId);
        t.settings = settings;
        if (settings.SAMSUNG_KNOX_CUSTOMER_ID) {
          t.samsungCustomerId = String(settings.SAMSUNG_KNOX_CUSTOMER_ID).trim();
        }
        const profileId =
          settings.SAMSUNG_KNOX_PROFILE_ID ||
          settings.SAMSUNG_PROFILE_ID ||
          settings.KNOX_PROFILE_ID;
        if (profileId) {
          t.samsungProfileId = String(profileId).trim();
        }
      } catch (err) {
        console.warn(`Error al consultar variables de One para tenant ${t.tenantId}:`, err.message);
      }
    }
  }

  // 3. Sincronizar / auto-provisionar en la base de datos
  const syncedClients = await syncOneTenants(tenantsFromOne);

  // Mapear settings y samsungProfileId en los syncedClients
  for (const client of syncedClients) {
    const match = tenantsFromOne.find((t) => t.tenantId === client.one_tenant_id);
    if (match) {
      client.settings = match.settings || {};
      client.samsungProfileId = match.samsungProfileId || null;
    }
  }

  return syncedClients;
}

module.exports = {
  syncUserTenants,
};

