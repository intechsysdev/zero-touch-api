#!/usr/bin/env node

const bcrypt = require('bcryptjs');
const { query, cerrarConexion } = require('../src/db');

function usage() {
  console.log(
    'Usage: npm run admin:create-client-user -- <clientId> <companyName> <zeroTouchCustomerId> [email]'
  );
}

async function main() {
  const clientId = (process.argv[2] || '').trim();
  const companyName = (process.argv[3] || '').trim();
  const zeroTouchCustomerId = (process.argv[4] || '').trim();
  const providedEmail = (process.argv[5] || '').trim().toLowerCase();

  if (!clientId || !companyName || !zeroTouchCustomerId) {
    usage();
    process.exit(1);
  }

  const email = providedEmail || `${clientId.toLowerCase()}@intechsys.local`;
  const passwordHash = bcrypt.hashSync(clientId, 10);
  const zeroTouchCustomerName = `customers/${zeroTouchCustomerId}`;

  const duplicateClient = await query(
    'SELECT TOP (1) id FROM clients WHERE client_id = @clientId',
    { clientId }
  );
  if (duplicateClient.rows[0]) {
    throw new Error(`clientId ya existe: ${clientId}`);
  }

  const duplicateEmail = await query(
    'SELECT TOP (1) id FROM users WHERE LOWER(email) = @email',
    { email }
  );
  if (duplicateEmail.rows[0]) {
    throw new Error(`email ya existe: ${email}`);
  }

  const clientInsert = await query(
    `
      INSERT INTO clients (client_id, company_name, zero_touch_customer_name, is_active)
      OUTPUT INSERTED.id
      VALUES (@clientId, @companyName, @zeroTouchCustomerName, 1)
    `,
    { clientId, companyName, zeroTouchCustomerName }
  );

  const userInsert = await query(
    `
      INSERT INTO users (email, password_hash, is_active)
      OUTPUT INSERTED.id
      VALUES (@email, @passwordHash, 1)
    `,
    { email, passwordHash }
  );

  await query(
    `
      INSERT INTO user_clients (user_id, client_id, role)
      VALUES (@userId, @clientDbId, N'admin')
    `,
    { userId: userInsert.rows[0].id, clientDbId: clientInsert.rows[0].id }
  );

  console.log('Client-user creado correctamente');
  console.log(`clientId=${clientId}`);
  console.log(`password(MVP)=${clientId}`);
  console.log(`email=${email}`);
  console.log(`companyName=${companyName}`);
  console.log(`zeroTouchCustomerName=${zeroTouchCustomerName}`);
}

main()
  .catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  })
  .finally(async () => {
    await cerrarConexion();
  });
