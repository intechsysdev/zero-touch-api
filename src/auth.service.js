const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { pool, writeAuditLog } = require('./db');
const { config } = require('./config');
const { syncClientDevices } = require('./zerotouch/zerotouch.sync');
const { listCustomers } = require('./zerotouch/zerotouch.client');
const {
  detectSamsungCustomerById,
  isSamsungConfigured,
} = require('./samsung/samsung.client');

const loginSchema = z.object({
  email: z.string().optional(),
  password: z.string().min(1),
  clientId: z.string().min(1),
});

async function login(payload) {
  const parsed = loginSchema.safeParse(payload);
  if (!parsed.success) {
    const errorText = parsed.error.issues.map((item) => item.message).join(', ');
    const error = new Error(errorText || 'Invalid payload.');
    error.statusCode = 400;
    throw error;
  }

  const { clientId, password, email } = parsed.data;
  const normalizedClientId = clientId.trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (password !== normalizedClientId) {
    const error = new Error('Para este MVP, password debe ser igual al clientId.');
    error.statusCode = 401;
    throw error;
  }

  const existingClientResult = await pool.query(
    `
      SELECT id, client_id, company_name, zero_touch_customer_name, is_active
      FROM clients
      WHERE client_id = $1
      LIMIT 1
    `,
    [normalizedClientId]
  );
  const existingClient = existingClientResult.rows[0] || null;

  let customers = [];
  try {
    const customersData = await listCustomers();
    customers = Array.isArray(customersData.customers) ? customersData.customers : [];
  } catch (error) {
    customers = [];
  }

  const matchedCustomer = customers.find(
    (item) => String(item.companyId || '') === normalizedClientId
  );

  const configuredSamsungCustomerIds = Array.isArray(
    config.samsungKnoxAllowedCustomerIds
  )
    ? config.samsungKnoxAllowedCustomerIds
    : [];

  const isConfiguredSamsungCustomer = configuredSamsungCustomerIds.includes(
    normalizedClientId
  );

  let samsungCustomerId = null;
  if (isSamsungConfigured()) {
    samsungCustomerId = await detectSamsungCustomerById(normalizedClientId);
  }
  if (!samsungCustomerId && isConfiguredSamsungCustomer) {
    samsungCustomerId = normalizedClientId;
  }

  const hasZeroTouch = Boolean(
    matchedCustomer?.name || existingClient?.zero_touch_customer_name
  );
  const hasSamsung = Boolean(samsungCustomerId);

  if (hasSamsung) {
    if (!normalizedEmail) {
      const error = new Error('Para Samsung Knox debes ingresar correo.');
      error.statusCode = 400;
      throw error;
    }

    const allowedEmails = new Set(
      [
        ...(config.samsungKnoxAllowedLoginEmails || []),
        config.samsungKnoxResellerEmail,
      ]
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
    );

    if (allowedEmails.size > 0 && !allowedEmails.has(normalizedEmail)) {
      const error = new Error('Correo no autorizado para Samsung Knox en este Client ID.');
      error.statusCode = 401;
      throw error;
    }
  }

  if (!hasZeroTouch && !hasSamsung) {
    const error = new Error('Client ID no existe en Zero Touch ni Samsung Knox.');
    error.statusCode = 401;
    throw error;
  }

  const zeroTouchCustomerName = matchedCustomer?.name
    ? String(matchedCustomer.name)
    : existingClient?.zero_touch_customer_name || null;
  const companyName = String(
    matchedCustomer?.companyName || existingClient?.company_name || 'Cliente Intechsys'
  );

  await pool.query(
    `
      INSERT INTO clients (client_id, company_name, zero_touch_customer_name, is_active)
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (client_id)
      DO UPDATE SET
        company_name = EXCLUDED.company_name,
        zero_touch_customer_name = COALESCE(EXCLUDED.zero_touch_customer_name, clients.zero_touch_customer_name),
        is_active = TRUE
    `,
    [normalizedClientId, companyName, zeroTouchCustomerName]
  );

  const clientResult = await pool.query(
    `
      SELECT id, client_id, company_name, zero_touch_customer_name, is_active
      FROM clients
      WHERE client_id = $1
      LIMIT 1
    `,
    [normalizedClientId]
  );
  const client = clientResult.rows[0] || null;

  if (!client) {
    const error = new Error('No fue posible preparar el cliente para login.');
    error.statusCode = 500;
    throw error;
  }

  const systemEmail = `client-${normalizedClientId}@intechsys.local`;
  const passwordHash = bcrypt.hashSync(normalizedClientId, 10);

  await pool.query(
    `
      INSERT INTO users (email, password_hash, is_active)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (email)
      DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        is_active = TRUE
    `,
    [systemEmail, passwordHash]
  );

  const userResult = await pool.query(
    'SELECT id, email, is_active FROM users WHERE email = $1 LIMIT 1',
    [systemEmail]
  );
  const user = userResult.rows[0] || null;

  if (!user) {
    const error = new Error('No fue posible preparar el usuario para login.');
    error.statusCode = 500;
    throw error;
  }

  await pool.query(
    `
      INSERT INTO user_clients (user_id, client_id, role)
      VALUES ($1, $2, 'admin')
      ON CONFLICT (user_id, client_id)
      DO UPDATE SET role = EXCLUDED.role
    `,
    [user.id, client.id]
  );

  const result = await pool.query(
    `
      SELECT
        u.id as user_id,
        u.email,
        u.password_hash,
        u.is_active as user_active,
        c.id as client_db_id,
        c.client_id,
        c.company_name,
        c.zero_touch_customer_name,
        c.is_active as client_active
      FROM users u
      INNER JOIN user_clients uc ON uc.user_id = u.id
      INNER JOIN clients c ON c.id = uc.client_id
      WHERE u.email = $1 AND c.client_id = $2
      ORDER BY u.id ASC
      LIMIT 1
    `,
    [systemEmail, normalizedClientId]
  );

  const row = result.rows[0] || null;

  if (!row) {
    const error = new Error('Credenciales invalidas.');
    error.statusCode = 401;
    throw error;
  }

  if (!row.user_active || !row.client_active) {
    const error = new Error('Usuario o cliente inactivo.');
    error.statusCode = 403;
    throw error;
  }

  const tokenPayload = {
    sub: String(row.user_id),
    clientId: row.client_id,
    clientDbId: row.client_db_id,
    zeroTouchAvailable: hasZeroTouch,
    samsungAvailable: hasSamsung,
    samsungCustomerId: samsungCustomerId || null,
  };

  const accessToken = jwt.sign(tokenPayload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

  await writeAuditLog({
    userId: row.user_id,
    clientDbId: row.client_db_id,
    action: 'auth.login.success',
    payload: {
      clientId: row.client_id,
      email: normalizedEmail || null,
      zeroTouchAvailable: hasZeroTouch,
      samsungAvailable: hasSamsung,
      samsungCustomerId: samsungCustomerId || null,
    },
  });

  const dbZeroTouchCustomerName = row.zero_touch_customer_name || null;
  const zeroTouchCustomerId = dbZeroTouchCustomerName
    ? String(dbZeroTouchCustomerName).split('/').pop()
    : null;

  if (zeroTouchCustomerId) {
    await syncClientDevices({
      clientDbId: Number(row.client_db_id),
      customerId: zeroTouchCustomerId,
    });
  }

  return {
    accessToken,
    companyName: row.company_name,
    email: normalizedEmail || null,
    clientId: row.client_id,
    zeroTouchAvailable: hasZeroTouch,
    zeroTouchCustomerName: dbZeroTouchCustomerName,
    zeroTouchCustomerId,
    samsungAvailable: hasSamsung,
    samsungCustomerId: samsungCustomerId || null,
    preferredEnrollment: hasZeroTouch ? 'zerotouch' : 'samsung',
  };
}

module.exports = { login };
