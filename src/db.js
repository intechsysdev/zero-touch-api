const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { config } = require('./config');

const pool = new Pool({
  connectionString: config.dbUrl,
});

const COLUMNAS_CLIENTE = `
  id, client_id, company_name, zero_touch_customer_name, one_tenant_id, one_slug, is_active,
  samsung_customer_id, plataformas_verificadas_at
`;

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id BIGSERIAL PRIMARY KEY,
      client_id TEXT UNIQUE NOT NULL,
      company_name TEXT NOT NULL,
      zero_touch_customer_name TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS user_clients (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'admin',
      PRIMARY KEY (user_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      client_id BIGINT,
      action TEXT NOT NULL,
      payload_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS client_devices (
      id BIGSERIAL PRIMARY KEY,
      client_db_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      external_key TEXT NOT NULL,
      device_id TEXT,
      serial_number TEXT,
      imei TEXT,
      model TEXT,
      manufacturer TEXT,
      raw_payload_json JSONB NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (client_db_id, external_key)
    );

    -- Migraciones automáticas para soporte multi-tenant de One
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS one_tenant_id UUID;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS one_slug TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS one_api_key TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS one_api_secret TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

    -- Plataformas en las que existe el Client ID, para no preguntarle a Google y a Knox en cada petición
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS samsung_customer_id TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS plataformas_verificadas_at TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_one_tenant_id ON clients (one_tenant_id) WHERE one_tenant_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_clients_one_slug ON clients (one_slug);
    CREATE INDEX IF NOT EXISTS idx_clients_api_key_hash ON clients (api_key_hash) WHERE api_key_hash IS NOT NULL;
  `);

  await seedInitialData();
}

async function seedInitialData() {
  const countResult = await pool.query('SELECT COUNT(1)::int as total FROM clients');
  const total = countResult.rows[0].total;
  if (total > 0) {
    return;
  }

  const clientIdValue = 'CLI-1001';
  const passwordHash = bcrypt.hashSync(clientIdValue, 10);

  const seedClient = await pool.query(
    `
      INSERT INTO clients (client_id, company_name, zero_touch_customer_name)
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [clientIdValue, 'Cliente Demo Intechsys', 'customers/1791589702']
  );

  const clientDbId = seedClient.rows[0].id;

  const seedUser = await pool.query(
    `
      INSERT INTO users (email, password_hash)
      VALUES ($1, $2)
      RETURNING id
    `,
    ['cliente.demo@intechsys.com', passwordHash]
  );

  const userDbId = seedUser.rows[0].id;

  await pool.query(
    'INSERT INTO user_clients (user_id, client_id, role) VALUES ($1, $2, $3)',
    [userDbId, clientDbId, 'admin']
  );
}

async function writeAuditLog({ userId = null, clientDbId = null, action, payload = {} }) {
  try {
    const safeUserId = Number.isInteger(Number(userId)) && !isNaN(Number(userId)) ? Number(userId) : null;
    const safeClientDbId = Number.isInteger(Number(clientDbId)) && !isNaN(Number(clientDbId)) ? Number(clientDbId) : null;
    await pool.query(
      'INSERT INTO audit_logs (user_id, client_id, action, payload_json) VALUES ($1, $2, $3, $4::jsonb)',
      [safeUserId, safeClientDbId, action, JSON.stringify(payload)]
    );
  } catch (error) {
    // Do not block main request flow if audit insert fails.
    console.error('Audit log insert failed:', error.message);
  }
}

async function checkDatabaseConnection() {
  await pool.query('SELECT 1');
}

async function getClientByDbId(clientDbId) {
  const result = await pool.query(
    `
      SELECT ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE id = $1
      LIMIT 1
    `,
    [clientDbId]
  );

  return result.rows[0] || null;
}

async function getClientByClientId(clientId) {
  const result = await pool.query(
    `
      SELECT ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE client_id = $1
      LIMIT 1
    `,
    [clientId]
  );

  return result.rows[0] || null;
}

function buildExternalKey(raw) {
  const identifier = raw.deviceIdentifier || {};
  const deviceId = raw.deviceId || raw.name || '';
  const serial = identifier.serialNumber || raw.serialNumber || '';
  const imei = identifier.imei || raw.imei || '';
  return String(deviceId || serial || imei || `unknown-${Date.now()}`);
}

async function replaceClientDevices(clientDbId, devices) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM client_devices WHERE client_db_id = $1', [clientDbId]);

    for (const raw of devices) {
      const identifier = raw.deviceIdentifier || {};
      const externalKey = buildExternalKey(raw);
      const deviceId = raw.deviceId || raw.name || null;
      const serialNumber = identifier.serialNumber || raw.serialNumber || null;
      const imei = identifier.imei || raw.imei || null;
      const model = identifier.model || raw.model || null;
      const manufacturer = identifier.manufacturer || raw.manufacturer || null;

      await client.query(
        `
          INSERT INTO client_devices (
            client_db_id,
            external_key,
            device_id,
            serial_number,
            imei,
            model,
            manufacturer,
            raw_payload_json,
            synced_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), now())
          ON CONFLICT (client_db_id, external_key)
          DO UPDATE SET
            device_id = EXCLUDED.device_id,
            serial_number = EXCLUDED.serial_number,
            imei = EXCLUDED.imei,
            model = EXCLUDED.model,
            manufacturer = EXCLUDED.manufacturer,
            raw_payload_json = EXCLUDED.raw_payload_json,
            synced_at = now(),
            updated_at = now()
        `,
        [
          clientDbId,
          externalKey,
          deviceId,
          serialNumber,
          imei,
          model,
          manufacturer,
          JSON.stringify(raw),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listClientDevices(clientDbId) {
  const result = await pool.query(
    `
      SELECT
        external_key,
        device_id,
        serial_number,
        imei,
        model,
        manufacturer,
        raw_payload_json,
        synced_at,
        updated_at
      FROM client_devices
      WHERE client_db_id = $1
      ORDER BY updated_at DESC
    `,
    [clientDbId]
  );

  return result.rows;
}

async function getClientByOneTenantId(oneTenantId) {
  if (!oneTenantId) return null;
  const result = await pool.query(
    `
      SELECT ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE one_tenant_id = $1
      LIMIT 1
    `,
    [oneTenantId]
  );
  return result.rows[0] || null;
}

async function getClientBySlug(slug) {
  if (!slug) return null;
  const result = await pool.query(
    `
      SELECT ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE one_slug = $1
      LIMIT 1
    `,
    [slug]
  );
  return result.rows[0] || null;
}

async function getClientByApiKeyHash(apiKeyHash) {
  if (!apiKeyHash) return null;
  const result = await pool.query(
    `
      SELECT ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE api_key_hash = $1 AND is_active = TRUE
      LIMIT 1
    `,
    [apiKeyHash]
  );
  return result.rows[0] || null;
}

/**
 * Sincroniza la lista de empresas de One asignadas al usuario para la app actual.
 * Equivalente a EmpresasOne.SincronizarAsync() de .NET.
 *
 * One manda, con cada empresa, su identificador en la app (`identifier`): el Client ID que la
 * empresa tiene como variable en One. Ese es el client_id local. Así una empresa que ya entraba
 * con su Client ID antes de One conserva su fila (y su caché de equipos) al vincularse.
 *
 * Orden de búsqueda: por one_tenant_id, por Client ID, por slug (empresa recreada en One con otro
 * GUID). Si no aparece, se crea.
 */
async function syncOneTenants(tenantsList = []) {
  const syncedClients = [];

  for (const tenant of tenantsList) {
    const { tenantId, name, slug, role } = tenant;
    if (!tenantId) continue;

    const companyName = name || slug || 'Empresa One';
    const companySlug = slug || tenantId;
    const identifier = tenant.identifier ? String(tenant.identifier).trim() : null;

    const byTenant = await getClientByOneTenantId(tenantId);
    const byIdentifier = identifier ? await getClientByClientId(identifier) : null;

    // La fila del Client ID manda: es la que tiene la historia de la empresa. Si One ya estaba
    // ligado a otra fila (creada antes de que la empresa tuviera Client ID), se suelta.
    let existing = byIdentifier || byTenant;
    if (byIdentifier && byTenant && byIdentifier.id !== byTenant.id) {
      await pool.query('UPDATE clients SET one_tenant_id = NULL, is_active = FALSE WHERE id = $1', [byTenant.id]);
    }
    if (!existing) {
      existing = await getClientBySlug(companySlug);
    }
    // Una fila de otra empresa que tenga este slug como client_id solo sirve si no tiene Client ID propio.
    if (!existing && !identifier) {
      existing = await getClientByClientId(companySlug);
    }
    if (existing?.one_tenant_id && String(existing.one_tenant_id).toLowerCase() !== String(tenantId).toLowerCase()
        && existing.id !== byIdentifier?.id) {
      existing = null;
    }

    if (existing) {
      const clientIdChanged = identifier && identifier !== existing.client_id;
      const result = await pool.query(
        `
          UPDATE clients
          SET one_tenant_id = $1, company_name = $2, one_slug = $3, is_active = TRUE,
              client_id = COALESCE($4, client_id),
              plataformas_verificadas_at = CASE WHEN $5 THEN NULL ELSE plataformas_verificadas_at END,
              zero_touch_customer_name = CASE WHEN $5 THEN NULL ELSE zero_touch_customer_name END,
              samsung_customer_id = CASE WHEN $5 THEN NULL ELSE samsung_customer_id END
          WHERE id = $6
          RETURNING ${COLUMNAS_CLIENTE}
        `,
        [tenantId, companyName, companySlug, identifier, Boolean(clientIdChanged), existing.id]
      );
      syncedClients.push({ ...result.rows[0], role: role || 'Member' });
      continue;
    }

    const created = await pool.query(
      `
        INSERT INTO clients (client_id, company_name, one_tenant_id, one_slug, is_active)
        VALUES ($1, $2, $3, $4, TRUE)
        RETURNING ${COLUMNAS_CLIENTE}
      `,
      [identifier || `one:${tenantId}`, companyName, tenantId, companySlug]
    );

    syncedClients.push({ ...created.rows[0], role: role || 'Member' });
  }

  return syncedClients;
}

async function getClientOneCredentials(clientDbId) {
  const result = await pool.query(
    `
      SELECT one_api_key, one_api_secret
      FROM clients
      WHERE id = $1
      LIMIT 1
    `,
    [clientDbId]
  );
  return result.rows[0] || null;
}

async function updateClientOneCredentials(clientDbId, { oneApiKey, oneApiSecret }) {
  await pool.query(
    `
      UPDATE clients
      SET one_api_key = $1, one_api_secret = $2
      WHERE id = $3
    `,
    [oneApiKey, oneApiSecret, clientDbId]
  );
}

module.exports = {
  pool,
  initDatabase,
  writeAuditLog,
  checkDatabaseConnection,
  getClientByDbId,
  getClientByClientId,
  getClientByOneTenantId,
  getClientBySlug,
  getClientByApiKeyHash,
  syncOneTenants,
  getClientOneCredentials,
  updateClientOneCredentials,
  replaceClientDevices,
  listClientDevices,
};
