const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { config } = require('./config');

const pool = new Pool({
  connectionString: config.dbUrl,
});

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
    await pool.query(
      'INSERT INTO audit_logs (user_id, client_id, action, payload_json) VALUES ($1, $2, $3, $4::jsonb)',
      [userId, clientDbId, action, JSON.stringify(payload)]
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
      SELECT id, client_id, company_name, zero_touch_customer_name, is_active
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
      SELECT id, client_id, company_name, zero_touch_customer_name, is_active
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
      SELECT id, client_id, company_name, zero_touch_customer_name, one_tenant_id, one_slug, is_active
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
      SELECT id, client_id, company_name, zero_touch_customer_name, one_tenant_id, one_slug, is_active
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
      SELECT id, client_id, company_name, zero_touch_customer_name, one_tenant_id, one_slug, is_active
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
 * Equivalente a EmpresasOne.SincronizarAsync() de .NET:
 * 1. Si la empresa existe por one_tenant_id -> actualiza nombre y slug.
 * 2. Si la empresa fue recreada en One (mismo slug, nuevo GUID) -> re-vincula al nuevo GUID.
 * 3. Si existe por client_id igual a slug -> re-vincula al nuevo GUID.
 * 4. Si es nueva -> crea fila en clients.
 */
async function syncOneTenants(tenantsList = []) {
  const syncedClients = [];

  for (const tenant of tenantsList) {
    const { tenantId, name, slug, role } = tenant;
    if (!tenantId) continue;

    const companyName = name || slug || 'Empresa One';
    const companySlug = slug || tenantId;

    // 1. Buscar por one_tenant_id
    let existing = await getClientByOneTenantId(tenantId);

    if (existing) {
      const updateResult = await pool.query(
        `
          UPDATE clients
          SET company_name = $1, one_slug = $2, is_active = TRUE
          WHERE id = $3
          RETURNING id, client_id, company_name, zero_touch_customer_name, one_tenant_id, one_slug, is_active
        `,
        [companyName, companySlug, existing.id]
      );
      syncedClients.push({ ...updateResult.rows[0], role: role || 'Member' });
      continue;
    }

    // 2. Buscar por slug (re-creada en One con nuevo GUID)
    existing = await getClientBySlug(companySlug);
    if (!existing) {
      // 3. Buscar si client_id coincide con el slug
      existing = await getClientByClientId(companySlug);
    }

    if (existing) {
      const reLinkResult = await pool.query(
        `
          UPDATE clients
          SET one_tenant_id = $1, company_name = $2, one_slug = $3, is_active = TRUE
          WHERE id = $4
          RETURNING id, client_id, company_name, zero_touch_customer_name, one_tenant_id, one_slug, is_active
        `,
        [tenantId, companyName, companySlug, existing.id]
      );
      syncedClients.push({ ...reLinkResult.rows[0], role: role || 'Member' });
      continue;
    }

    // 4. Empresa nueva -> insertar
    const newClient = await pool.query(
      `
        INSERT INTO clients (client_id, company_name, one_tenant_id, one_slug, is_active)
        VALUES ($1, $2, $3, $4, TRUE)
        ON CONFLICT (client_id)
        DO UPDATE SET
          company_name = EXCLUDED.company_name,
          one_tenant_id = EXCLUDED.one_tenant_id,
          one_slug = EXCLUDED.one_slug,
          is_active = TRUE
        RETURNING id, client_id, company_name, zero_touch_customer_name, one_tenant_id, one_slug, is_active
      `,
      [companySlug, companyName, tenantId, companySlug]
    );

    syncedClients.push({ ...newClient.rows[0], role: role || 'Member' });
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
