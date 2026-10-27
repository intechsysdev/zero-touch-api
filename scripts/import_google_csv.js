#!/usr/bin/env node

/**
 * scripts/import_google_csv.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Importa el archivo CSV exportado desde Google Zero-touch (partner.android.com)
 * directamente a la base de datos SQL Server o vía API.
 *
 * Uso local directo con BD:
 *   node scripts/import_google_csv.js [ruta_al_csv] [clientDbId]
 *
 * Ejemplo:
 *   node scripts/import_google_csv.js /Users/junior.development/Downloads/devices.csv
 */

const fs = require('fs');
const path = require('path');
const { importGoogleCsv } = require('../src/zerotouch/csv-import');
const { initDatabase, cerrarConexion } = require('../src/db');

async function main() {
  const localPath = path.join(__dirname, '../src/zerotouch/devices.csv');
  const downloadsPath = '/Users/junior.development/Downloads/devices.csv';
  const defaultPath = fs.existsSync(localPath) ? localPath : downloadsPath;
  const csvPath = process.argv[2] || defaultPath;
  const clientDbId = process.argv[3] ? Number(process.argv[3]) : 0;

  if (!fs.existsSync(csvPath)) {
    console.error(`Error: Archivo no encontrado en: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Leyendo CSV desde: ${csvPath}...`);
  const csvText = fs.readFileSync(csvPath, 'utf8');

  console.log('Conectando a base de datos...');
  await initDatabase();

  console.log(`Iniciando importación ${clientDbId ? `para clientDbId=${clientDbId}` : 'para todos los clientes'}...`);
  const result = await importGoogleCsv(clientDbId, csvText);

  console.log('\n--- RESULTADOS DE LA IMPORTACIÓN ---');
  console.log(`Total filas en CSV:   ${result.totalRows}`);
  console.log(`Equipos actualizados: ${result.updated}`);
  console.log(`Equipos no cruzados:  ${result.unmatched} (equipos en CSV que no estaban en DB)`);
  console.log(`Filas omitidas:       ${result.skipped}`);
  if (result.errors.length > 0) {
    console.log(`Errores:              ${result.errors.length}`);
    console.log(result.errors.slice(0, 5));
  }
  console.log('------------------------------------');

  await cerrarConexion().catch(() => {});
}

main().catch((err) => {
  console.error('Error durante la importación:', err.message);
  process.exit(1);
});

