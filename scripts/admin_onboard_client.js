#!/usr/bin/env node

const bcrypt = require('bcryptjs');
const { query, cerrarConexion } = require('../src/db');

function usage() {
  console.log(
    'Usage: npm run admin:onboard-client -- <email> <clientId> <companyName> <zeroTouchCustomerId>'
  );
}

async function upsertClient({ clientId, companyName, zeroTouchCustomerId }) {
  const customerName = `customers/${zeroTouchCustomerId}`;

  const existing = await query(
    'SELECT TOP (1) id FROM clients WHERE client_id = @clientId',
    { clientId }
  );

  if (existing.rows[0]) {
    const clientDbId = existing.rows[0].id;
    await query(
      `
        UPDATE clients
        SET company_name = @companyName,
            zero_touch_customer_name = @customerName,
            is_active = 1
        WHERE id = @clientDbId
      `,
      { companyName, customerName, clientDbId }
    );
    return clientDbId;
  }

  const created = await query(
    `
      INSERT INTO clients (client_id, company_name, zero_touch_customer_name, is_active)
      OUTPUT INSERTED.id
      VALUES (@clientId, @companyName, @customerName, 1)
    `,
    { clientId, companyName, customerName }
  );

  return created.rows[0].id;
}

async function upsertUser({ email, clientId }) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = bcrypt.hashSync(clientId, 10);

  const existing = await query(
    'SELECT TOP (1) id FROM users WHERE LOWER(email) = @email',
    { email: normalizedEmail }
  );

  if (existing.rows[0]) {
    const userDbId = existing.rows[0].id;
    await query(
      `
        UPDATE users
        SET password_hash = @passwordHash,
            is_active = 1
        WHERE id = @userDbId
      `,
      { passwordHash, userDbId }
    );
    return userDbId;
  }

  const created = await query(
    `
      INSERT INTO users (email, password_hash, is_active)
      OUTPUT INSERTED.id
      VALUES (@email, @passwordHash, 1)
    `,
    { email: normalizedEmail, passwordHash }
  );

  return created.rows[0].id;
}

async function upsertUserClient({ userDbId, clientDbId }) {
  await query(
    `
      UPDATE user_clients SET role = N'admin' WHERE user_id = @userDbId AND client_id = @clientDbId;
      IF @@ROWCOUNT = 0
        INSERT INTO user_clients (user_id, client_id, role) VALUES (@userDbId, @clientDbId, N'admin');
    `,
    { userDbId, clientDbId }
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
    await cerrarConexion();
  });
