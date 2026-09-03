#!/usr/bin/env node

const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

function usage() {
  console.log(
    'Usage: npm run admin:onboard-client -- <email> <clientId> <companyName> <zeroTouchCustomerId>'
  );
}

async function upsertClient({ clientId, companyName, zeroTouchCustomerId }) {
  const customerName = `customers/${zeroTouchCustomerId}`;

  const existing = await pool.query(
    'SELECT id FROM clients WHERE client_id = $1 LIMIT 1',
    [clientId]
  );

  if (existing.rows[0]) {
    const clientDbId = existing.rows[0].id;
    await pool.query(
      `
        UPDATE clients
        SET company_name = $1,
            zero_touch_customer_name = $2,
            is_active = TRUE
        WHERE id = $3
      `,
      [companyName, customerName, clientDbId]
    );
    return clientDbId;
  }

  const created = await pool.query(
    `
      INSERT INTO clients (client_id, company_name, zero_touch_customer_name, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id
    `,
    [clientId, companyName, customerName]
  );

  return created.rows[0].id;
}

async function upsertUser({ email, clientId }) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = bcrypt.hashSync(clientId, 10);

  const existing = await pool.query(
    'SELECT id FROM users WHERE lower(email) = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (existing.rows[0]) {
    const userDbId = existing.rows[0].id;
    await pool.query(
      `
        UPDATE users
        SET password_hash = $1,
            is_active = TRUE
        WHERE id = $2
      `,
      [passwordHash, userDbId]
    );
    return userDbId;
  }

  const created = await pool.query(
    `
      INSERT INTO users (email, password_hash, is_active)
      VALUES ($1, $2, TRUE)
      RETURNING id
    `,
    [normalizedEmail, passwordHash]
  );

  return created.rows[0].id;
}

async function upsertUserClient({ userDbId, clientDbId }) {
  await pool.query(
    `
      INSERT INTO user_clients (user_id, client_id, role)
      VALUES ($1, $2, 'admin')
      ON CONFLICT (user_id, client_id) DO UPDATE SET role = EXCLUDED.role
    `,
    [userDbId, clientDbId]
  );
}

async function main() {
  const email = process.argv[2];
  const clientId = process.argv[3];
  const companyName = process.argv[4];
  const zeroTouchCustomerId = process.argv[5];

  if (!email || !clientId || !companyName || !zeroTouchCustomerId) {
    usage();
    process.exit(1);
  }

  const clientDbId = await upsertClient({
    clientId: clientId.trim(),
    companyName: companyName.trim(),
    zeroTouchCustomerId: zeroTouchCustomerId.trim(),
  });

  const userDbId = await upsertUser({
    email,
    clientId: clientId.trim(),
  });

  await upsertUserClient({ userDbId, clientDbId });

  console.log('Onboarding completed');
  console.log(`email=${email.trim().toLowerCase()}`);
  console.log(`clientId=${clientId.trim()}`);
  console.log(`companyName=${companyName.trim()}`);
  console.log(`zeroTouchCustomerName=customers/${zeroTouchCustomerId.trim()}`);
  console.log('MVP password rule: password must be equal to clientId.');
}

main()
  .catch((error) => {
    console.error('Failed to onboard client:', error.message);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
