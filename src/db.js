const bcrypt = require('bcryptjs');
const sql = require('mssql');
const { config } = require('./config');

/**
 * Conexión a SQL Server (Azure SQL Database en producción) con el driver tedious de `mssql`.
 *
 * El pool se abre con la primera consulta, no al cargar el módulo: así `require('./src/server')`
 * (la verificación del pipeline) no necesita base de datos. Si la conexión falla se descarta el
 * pool y la siguiente consulta lo vuelve a intentar.
 */
function opcionesConexion() {
  const db = config.db;
  if (db.connectionString) {
    return db.connectionString;
  }
  return {
    server: db.server,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    connectionTimeout: db.connectionTimeoutMs,
    requestTimeout: db.requestTimeoutMs,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: db.encrypt,
      trustServerCertificate: db.trustServerCertificate,
      // Las fechas se guardan en UTC (SYSUTCDATETIME) y se leen como UTC.
      useUTC: true,
    },
  };
}

let poolActual = null;
let poolListo = null;

function obtenerPool() {
  if (!poolListo) {
    poolActual = new sql.ConnectionPool(opcionesConexion());
    poolActual.on('error', (error) => {
      console.error('Error en el pool de SQL Server:', error.message);
    });
    const pool = poolActual;
    poolListo = pool.connect().catch((error) => {
      if (poolActual === pool) {
        poolActual = null;
        poolListo = null;
      }
      throw error;
    });
  }
  return poolListo;
}

async function cerrarConexion() {
  const listo = poolListo;
  poolActual = null;
  poolListo = null;
  if (listo) {
    const pool = await listo.catch(() => null);
    if (pool) await pool.close();
  }
}

/**
 * Deja las filas como las entregaba PostgreSQL: el GUID de One en minúsculas (SQL Server lo
 * devuelve en mayúsculas y la sesión lo compara tal cual con el de One) y las columnas JSON ya
 * convertidas en objeto.
 */
function normalizarFila(row) {
  if (!row) return row;
  if (typeof row.one_tenant_id === 'string') {
    row.one_tenant_id = row.one_tenant_id.toLowerCase();
  }
  for (const columna of ['raw_payload_json', 'payload_json']) {
    if (typeof row[columna] === 'string') {
      try {
        row[columna] = JSON.parse(row[columna]);
      } catch (error) {
        // Se deja el texto tal cual si no es JSON válido.
      }
    }
  }
  return row;
}

/** Agrega los parámetros (@nombre) a la petición. Un valor `{ tipo, valor }` fija el tipo SQL. */
function agregarParametros(request, params = {}) {
  for (const [nombre, valor] of Object.entries(params)) {
    if (valor && typeof valor === 'object' && 'tipo' in valor) {
      request.input(nombre, valor.tipo, valor.valor === undefined ? null : valor.valor);
    } else {
      request.input(nombre, valor === undefined ? null : valor);
    }
  }
  return request;
}

/**
 * Ejecuta una consulta con parámetros con nombre (`@id`, `@nombre`...) y devuelve `{ rows }`,
 * igual que `pool.query` de pg. Con `transaccion` corre dentro de ella.
 */
async function query(texto, params = {}, transaccion = null) {
  const request = transaccion ? new sql.Request(transaccion) : (await obtenerPool()).request();
  agregarParametros(request, params);
  const result = await request.query(texto);
  const rows = (result.recordset || []).map(normalizarFila);
  return { rows, rowCount: result.rowsAffected?.[0] ?? rows.length };
}

const idBd = (valor) => ({ tipo: sql.BigInt, valor: valor === null || valor === undefined ? null : String(valor) });

const COLUMNAS_CLIENTE = `
  id, client_id, company_name, zero_touch_customer_name, one_tenant_id, one_slug, is_active,
  samsung_customer_id, plataformas_verificadas_at
`;

const COLUMNAS_CLIENTE_INSERTADAS = COLUMNAS_CLIENTE.split(',')
  .map((columna) => `INSERTED.${columna.trim()}`)
  .join(', ');

// Cada paso es idempotente: se puede correr en cada arranque sin tocar lo que ya existe.
const ESQUEMA = [
  `
    IF OBJECT_ID(N'dbo.clients', N'U') IS NULL
    CREATE TABLE dbo.clients (
      id BIGINT IDENTITY(1,1) PRIMARY KEY,
      client_id NVARCHAR(200) NOT NULL CONSTRAINT uq_clients_client_id UNIQUE,
      company_name NVARCHAR(400) NOT NULL,
      zero_touch_customer_name NVARCHAR(200) NULL,
      is_active BIT NOT NULL CONSTRAINT df_clients_is_active DEFAULT 1,
      created_at DATETIME2 NOT NULL CONSTRAINT df_clients_created_at DEFAULT SYSUTCDATETIME()
    );
  `,
  `
    IF OBJECT_ID(N'dbo.users', N'U') IS NULL
    CREATE TABLE dbo.users (
      id BIGINT IDENTITY(1,1) PRIMARY KEY,
      email NVARCHAR(320) NOT NULL CONSTRAINT uq_users_email UNIQUE,
      password_hash NVARCHAR(200) NOT NULL,
      is_active BIT NOT NULL CONSTRAINT df_users_is_active DEFAULT 1,
      created_at DATETIME2 NOT NULL CONSTRAINT df_users_created_at DEFAULT SYSUTCDATETIME()
    );
  `,
  `
    IF OBJECT_ID(N'dbo.user_clients', N'U') IS NULL
    CREATE TABLE dbo.user_clients (
      user_id BIGINT NOT NULL CONSTRAINT fk_user_clients_user REFERENCES dbo.users(id) ON DELETE CASCADE,
      client_id BIGINT NOT NULL CONSTRAINT fk_user_clients_client REFERENCES dbo.clients(id) ON DELETE CASCADE,
      role NVARCHAR(50) NOT NULL CONSTRAINT df_user_clients_role DEFAULT N'admin',
      CONSTRAINT pk_user_clients PRIMARY KEY (user_id, client_id)
    );
  `,
  `
    IF OBJECT_ID(N'dbo.audit_logs', N'U') IS NULL
    CREATE TABLE dbo.audit_logs (
      id BIGINT IDENTITY(1,1) PRIMARY KEY,
      user_id BIGINT NULL,
      client_id BIGINT NULL,
      action NVARCHAR(200) NOT NULL,
      payload_json NVARCHAR(MAX) NULL,
      created_at DATETIME2 NOT NULL CONSTRAINT df_audit_logs_created_at DEFAULT SYSUTCDATETIME()
    );
  `,
  `
    IF OBJECT_ID(N'dbo.client_devices', N'U') IS NULL
    CREATE TABLE dbo.client_devices (
      id BIGINT IDENTITY(1,1) PRIMARY KEY,
      client_db_id BIGINT NOT NULL CONSTRAINT fk_client_devices_client REFERENCES dbo.clients(id) ON DELETE CASCADE,
      external_key NVARCHAR(450) NOT NULL,
      device_id NVARCHAR(450) NULL,
      serial_number NVARCHAR(200) NULL,
      imei NVARCHAR(50) NULL,
      model NVARCHAR(200) NULL,
      manufacturer NVARCHAR(200) NULL,
      raw_payload_json NVARCHAR(MAX) NOT NULL,
      synced_at DATETIME2 NOT NULL CONSTRAINT df_client_devices_synced_at DEFAULT SYSUTCDATETIME(),
      created_at DATETIME2 NOT NULL CONSTRAINT df_client_devices_created_at DEFAULT SYSUTCDATETIME(),
      updated_at DATETIME2 NOT NULL CONSTRAINT df_client_devices_updated_at DEFAULT SYSUTCDATETIME(),
      CONSTRAINT uq_client_devices_external_key UNIQUE (client_db_id, external_key)
    );
  `,
  // Columnas agregadas después (soporte multi-tenant de One y plataformas del Client ID)
  ...[
    ['one_tenant_id', 'UNIQUEIDENTIFIER NULL'],
    ['one_slug', 'NVARCHAR(200) NULL'],
    ['one_api_key', 'NVARCHAR(500) NULL'],
    ['one_api_secret', 'NVARCHAR(500) NULL'],
    ['api_key_hash', 'NVARCHAR(128) NULL'],
    // Plataformas en las que existe el Client ID, para no preguntarle a Google y a Knox en cada petición
    ['samsung_customer_id', 'NVARCHAR(200) NULL'],
    ['plataformas_verificadas_at', 'DATETIME2 NULL'],
  ].map(
    ([columna, definicion]) => `
      IF COL_LENGTH(N'dbo.clients', N'${columna}') IS NULL
        ALTER TABLE dbo.clients ADD ${columna} ${definicion};
    `
  ),
  `
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_clients_one_tenant_id' AND object_id = OBJECT_ID(N'dbo.clients'))
      CREATE UNIQUE INDEX idx_clients_one_tenant_id ON dbo.clients (one_tenant_id) WHERE one_tenant_id IS NOT NULL;
  `,
  `
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_clients_one_slug' AND object_id = OBJECT_ID(N'dbo.clients'))
      CREATE INDEX idx_clients_one_slug ON dbo.clients (one_slug);
  `,
  `
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_clients_api_key_hash' AND object_id = OBJECT_ID(N'dbo.clients'))
      CREATE INDEX idx_clients_api_key_hash ON dbo.clients (api_key_hash) WHERE api_key_hash IS NOT NULL;
  `,
];

async function initDatabase() {
  // Todo va en una transacción con un candado de aplicación: si arrancan varias instancias a la
  // vez (App Service escalado) la segunda espera y encuentra el esquema ya creado. Cada paso va
  // en su propio lote porque una columna nueva solo se puede usar en el lote siguiente.
  const pool = await obtenerPool();
  const transaccion = new sql.Transaction(pool);
  await transaccion.begin();
  try {
    await query(
      `
        DECLARE @resultado INT;
        EXEC @resultado = sp_getapplock @Resource = N'zero-touch-esquema', @LockMode = N'Exclusive',
          @LockOwner = N'Transaction', @LockTimeout = 120000;
        IF @resultado < 0 THROW 50001, N'No se obtuvo el candado para crear el esquema.', 1;
      `,
      {},
      transaccion
    );

    for (const paso of ESQUEMA) {
      await query(paso, {}, transaccion);
    }

    await seedInitialData(transaccion);
    await transaccion.commit();
  } catch (error) {
    await transaccion.rollback().catch(() => {});
    throw error;
  }
}

async function seedInitialData(transaccion) {
  const countResult = await query('SELECT COUNT(1) AS total FROM clients', {}, transaccion);
  const total = countResult.rows[0].total;
  if (total > 0) {
    return;
  }

  const clientIdValue = 'CLI-1001';
  const passwordHash = bcrypt.hashSync(clientIdValue, 10);

  const seedClient = await query(
    `
      INSERT INTO clients (client_id, company_name, zero_touch_customer_name)
      OUTPUT INSERTED.id
      VALUES (@clientId, @companyName, @customerName)
    `,
    {
      clientId: clientIdValue,
      companyName: 'Cliente Demo Intechsys',
      customerName: 'customers/1791589702',
    },
    transaccion
  );

  const clientDbId = seedClient.rows[0].id;

  const seedUser = await query(
    `
      INSERT INTO users (email, password_hash)
      OUTPUT INSERTED.id
      VALUES (@email, @passwordHash)
    `,
    { email: 'cliente.demo@intechsys.com', passwordHash },
    transaccion
  );

  const userDbId = seedUser.rows[0].id;

  await query(
    'INSERT INTO user_clients (user_id, client_id, role) VALUES (@userId, @clientId, @role)',
    { userId: idBd(userDbId), clientId: idBd(clientDbId), role: 'admin' },
    transaccion
  );
}

async function writeAuditLog({ userId = null, clientDbId = null, action, payload = {} }) {
  try {
    const safeUserId = Number.isInteger(Number(userId)) && !isNaN(Number(userId)) ? Number(userId) : null;
    const safeClientDbId = Number.isInteger(Number(clientDbId)) && !isNaN(Number(clientDbId)) ? Number(clientDbId) : null;
    await query(
      'INSERT INTO audit_logs (user_id, client_id, action, payload_json) VALUES (@userId, @clientId, @action, @payload)',
      {
        userId: idBd(safeUserId),
        clientId: idBd(safeClientDbId),
        action: { tipo: sql.NVarChar(200), valor: action },
        payload: { tipo: sql.NVarChar(sql.MAX), valor: JSON.stringify(payload) },
      }
    );
  } catch (error) {
    // Do not block main request flow if audit insert fails.
    console.error('Audit log insert failed:', error.message);
  }
}

async function checkDatabaseConnection() {
  await query('SELECT 1 AS ok');
}

async function getClientByDbId(clientDbId) {
  const result = await query(
    `
      SELECT TOP (1) ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE id = @id
    `,
    { id: idBd(clientDbId) }
  );

  return result.rows[0] || null;
}

async function getClientByClientId(clientId) {
  const result = await query(
    `
      SELECT TOP (1) ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE client_id = @clientId
    `,
    { clientId: { tipo: sql.NVarChar(200), valor: clientId } }
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
  const pool = await obtenerPool();
  const transaccion = new sql.Transaction(pool);
  await transaccion.begin();
  try {
    await query('DELETE FROM client_devices WHERE client_db_id = @clientDbId', { clientDbId: idBd(clientDbId) }, transaccion);

    for (const raw of devices) {
      const identifier = raw.deviceIdentifier || {};
      const externalKey = buildExternalKey(raw);
      const deviceId = raw.deviceId || raw.name || null;
      const serialNumber = identifier.serialNumber || raw.serialNumber || null;
      const imei = identifier.imei || raw.imei || null;
      const model = identifier.model || raw.model || null;
      const manufacturer = identifier.manufacturer || raw.manufacturer || null;

      // Si la lista trae dos veces el mismo equipo, el último gana (como el ON CONFLICT de antes).
      await query(
        `
          UPDATE client_devices
          SET device_id = @deviceId,
              serial_number = @serialNumber,
              imei = @imei,
              model = @model,
              manufacturer = @manufacturer,
              raw_payload_json = @rawPayload,
              synced_at = SYSUTCDATETIME(),
              updated_at = SYSUTCDATETIME()
          WHERE client_db_id = @clientDbId AND external_key = @externalKey;

          IF @@ROWCOUNT = 0
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
            VALUES (
              @clientDbId, @externalKey, @deviceId, @serialNumber, @imei, @model, @manufacturer,
              @rawPayload, SYSUTCDATETIME(), SYSUTCDATETIME()
            );
        `,
        {
          clientDbId: idBd(clientDbId),
          externalKey: { tipo: sql.NVarChar(450), valor: externalKey },
          deviceId: { tipo: sql.NVarChar(450), valor: deviceId },
          serialNumber: { tipo: sql.NVarChar(200), valor: serialNumber },
          imei: { tipo: sql.NVarChar(50), valor: imei },
          model: { tipo: sql.NVarChar(200), valor: model },
          manufacturer: { tipo: sql.NVarChar(200), valor: manufacturer },
          rawPayload: { tipo: sql.NVarChar(sql.MAX), valor: JSON.stringify(raw) },
        },
        transaccion
      );
    }

    await transaccion.commit();
  } catch (error) {
    await transaccion.rollback().catch(() => {});
    throw error;
  }
}

async function listClientDevices(clientDbId) {
  const result = await query(
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
      WHERE client_db_id = @clientDbId
      ORDER BY updated_at DESC
    `,
    { clientDbId: idBd(clientDbId) }
  );

  return result.rows;
}

async function getClientByOneTenantId(oneTenantId) {
  if (!oneTenantId) return null;
  // TRY_CONVERT: un X-Tenant-Id que no es GUID simplemente no encuentra empresa.
  const result = await query(
    `
      SELECT TOP (1) ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE one_tenant_id = TRY_CONVERT(UNIQUEIDENTIFIER, @oneTenantId)
    `,
    { oneTenantId: { tipo: sql.NVarChar(100), valor: String(oneTenantId) } }
  );
  return result.rows[0] || null;
}

async function getClientBySlug(slug) {
  if (!slug) return null;
  const result = await query(
    `
      SELECT TOP (1) ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE one_slug = @slug
    `,
    { slug: { tipo: sql.NVarChar(200), valor: slug } }
  );
  return result.rows[0] || null;
}

async function getClientByApiKeyHash(apiKeyHash) {
  if (!apiKeyHash) return null;
  const result = await query(
    `
      SELECT TOP (1) ${COLUMNAS_CLIENTE}
      FROM clients
      WHERE api_key_hash = @apiKeyHash AND is_active = 1
    `,
    { apiKeyHash: { tipo: sql.NVarChar(128), valor: apiKeyHash } }
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
      await query('UPDATE clients SET one_tenant_id = NULL, is_active = 0 WHERE id = @id', { id: idBd(byTenant.id) });
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
      const result = await query(
        `
          UPDATE clients
          SET one_tenant_id = @tenantId, company_name = @companyName, one_slug = @slug, is_active = 1,
              client_id = COALESCE(@identifier, client_id),
              plataformas_verificadas_at = CASE WHEN @cambioClientId = 1 THEN NULL ELSE plataformas_verificadas_at END,
              zero_touch_customer_name = CASE WHEN @cambioClientId = 1 THEN NULL ELSE zero_touch_customer_name END,
              samsung_customer_id = CASE WHEN @cambioClientId = 1 THEN NULL ELSE samsung_customer_id END
          OUTPUT ${COLUMNAS_CLIENTE_INSERTADAS}
          WHERE id = @id
        `,
        {
          tenantId: { tipo: sql.UniqueIdentifier, valor: tenantId },
          companyName: { tipo: sql.NVarChar(400), valor: companyName },
          slug: { tipo: sql.NVarChar(200), valor: companySlug },
          identifier: { tipo: sql.NVarChar(200), valor: identifier },
          cambioClientId: { tipo: sql.Bit, valor: Boolean(clientIdChanged) },
          id: idBd(existing.id),
        }
      );
      syncedClients.push({ ...result.rows[0], role: role || 'Member' });
      continue;
    }

    const created = await query(
      `
        INSERT INTO clients (client_id, company_name, one_tenant_id, one_slug, is_active)
        OUTPUT ${COLUMNAS_CLIENTE_INSERTADAS}
        VALUES (@clientId, @companyName, @tenantId, @slug, 1)
      `,
      {
        clientId: { tipo: sql.NVarChar(200), valor: identifier || `one:${tenantId}` },
        companyName: { tipo: sql.NVarChar(400), valor: companyName },
        tenantId: { tipo: sql.UniqueIdentifier, valor: tenantId },
        slug: { tipo: sql.NVarChar(200), valor: companySlug },
      }
    );

    syncedClients.push({ ...created.rows[0], role: role || 'Member' });
  }

  return syncedClients;
}

async function getClientOneCredentials(clientDbId) {
  const result = await query(
    `
      SELECT TOP (1) one_api_key, one_api_secret
      FROM clients
      WHERE id = @id
    `,
    { id: idBd(clientDbId) }
  );
  return result.rows[0] || null;
}

async function updateClientOneCredentials(clientDbId, { oneApiKey, oneApiSecret }) {
  await query(
    `
      UPDATE clients
      SET one_api_key = @oneApiKey, one_api_secret = @oneApiSecret
      WHERE id = @id
    `,
    {
      oneApiKey: { tipo: sql.NVarChar(500), valor: oneApiKey },
      oneApiSecret: { tipo: sql.NVarChar(500), valor: oneApiSecret },
      id: idBd(clientDbId),
    }
  );
}

module.exports = {
  // El pool de mssql; null hasta la primera consulta. Para SQL propio use `query`.
  get pool() {
    return poolActual;
  },
  sql,
  query,
  obtenerPool,
  cerrarConexion,
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
