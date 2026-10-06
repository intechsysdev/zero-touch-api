const { listUserAppTenants } = require('./one.client');
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

  // 2. Sincronizar / auto-provisionar en PostgreSQL
  const syncedClients = await syncOneTenants(tenantsFromOne);

  return syncedClients;
}

module.exports = {
  syncUserTenants,
};

