#!/usr/bin/env node

/**
 * Script para generar la URL de prueba de SSO desde One.
 * Hace login contra la API real de One, obtiene el token del usuario y genera
 * las URLs listas para probar en el navegador tanto en local como en producción.
 */

const { oneConfig } = require('../src/one');

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!password) {
    console.error('Uso: node scripts/generate_one_sso_link.js <correo> <contraseña>');
    process.exit(1);
  }

  console.log('Iniciando sesión en One con:', email);

  const res = await fetch(`${oneConfig.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    console.error('Error al iniciar sesión en One:', res.status, await res.text());
    process.exit(1);
  }

  const data = await res.json();
  const token = data.accessToken || data.token;

  // Consultar tenants asignados
  const tenantsRes = await fetch(`${oneConfig.baseUrl}/api/v1/me/apps/zero-touch/tenants`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const tenants = await tenantsRes.json();

  console.log('\n============================================================');
  console.log('✅ TOKEN DE ONE OBTENIDO CON ÉXITO');
  console.log('Usuario:', data.user?.fullName || email);
  console.log('============================================================\n');

  console.log('Empresas disponibles en One para Zero Touch:');
  tenants.forEach((t, i) => {
    console.log(`  [${i + 1}] ${t.name} (Slug: ${t.slug})`);
    console.log(`      TenantId: ${t.tenantId}`);
  });

  console.log('\n------------------------------------------------------------');
  console.log('🔗 URLS PARA PROBAR EN TU NAVEGADOR (Lanzamiento directo SSO)');
  console.log('------------------------------------------------------------\n');

  // Enlaces para local (http://localhost:5173)
  console.log('👉 EN LOCAL (Vite dev server en localhost:5173):');
  tenants.forEach((t) => {
    console.log(`\n• Para entrar a: "${t.name}"`);
    console.log(`  http://localhost:5173/?token=${token}&tenantId=${t.tenantId}`);
  });

  console.log('\n\n👉 ENLACE GENERAL (selector de empresa automático):');
  console.log(`  http://localhost:5173/?token=${token}\n`);
}

main().catch(console.error);

