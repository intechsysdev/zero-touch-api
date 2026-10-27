/**
 * scripts/test_simulation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Script de prueba completa para verificar que toda la lógica funciona al 100%
 * SIN tocar la base de datos de producción ni tocar la rama main.
 *
 * Ejecutar con:
 *   node scripts/test_simulation.js
 */

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../src/zerotouch/csv-import');
const { resolveModelFromImei, catalogMap, learnFromCsvRows } = require('../src/zerotouch/device-catalog');

async function run() {
  console.log('===============================================================');
  console.log('🧪 INICIANDO PRUEBAS DE VALIDACIÓN (RAMA: zerotouch_fix)');
  console.log('===============================================================\n');

  // PRUEBA 1: Verificar el archivo devices.csv descargado
  const csvPath = '/Users/junior.development/Downloads/devices.csv';
  console.log(`1. Verificando archivo CSV en: ${csvPath}`);
  if (!fs.existsSync(csvPath)) {
    console.error('❌ No se encontró el archivo devices.csv');
    process.exit(1);
  }
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  console.log(`   ✅ Archivo encontrado (${(csvContent.length / 1024 / 1024).toFixed(2)} MB)\n`);

  // PRUEBA 2: Parsear el CSV con el parser nativo
  console.log('2. Parseando archivo CSV...');
  const { headers, rows } = parseCsv(csvContent);
  console.log(`   ✅ Encabezados detectados: ${headers.slice(0, 7).join(', ')}...`);
  console.log(`   ✅ Total de dispositivos parseados: ${rows.length}\n`);

  // PRUEBA 3: Auto-aprendizaje de modelos desde las filas del CSV
  console.log('3. Ejecutando auto-aprendizaje de modelos de hardware...');
  const learningResult = await learnFromCsvRows(rows);
  console.log(`   ✅ Modelos de hardware en el catálogo: ${learningResult.totalInCatalog}`);
  console.log(`   ✅ Modelos nuevos aprendidos: ${learningResult.learnedCount}\n`);

  // PRUEBA 4: Simulación de resolución de dispositivos problemáticos
  console.log('4. Probando resolución de hardware por IMEI (Caso real):');
  const casosDePrueba = [
    {
      imei: '354555937928120',
      cliente: 'Recamier',
      esperado: { mfr: 'Samsung', model: 'Galaxy A27 5G' }
    },
    {
      imei: '864892061032558',
      cliente: 'Forus Colombia',
      esperado: { mfr: 'Lenovo', model: 'Lenovo Tab M10 HD (2nd Gen)' }
    },
    {
      imei: '353142720514804',
      cliente: 'Tecnoquimicas',
      esperado: { mfr: 'Samsung', model: 'Galaxy A56 5G' }
    },
    {
      imei: '358372341198456',
      cliente: 'Recamier',
      esperado: { mfr: 'Samsung', model: 'Galaxy A37 5G' }
    },
    {
      imei: '990011947107271',
      cliente: 'Quala',
      esperado: { mfr: 'Honeywell', model: 'EDA51' }
    },
    {
      imei: '860003041226625',
      cliente: 'Banco de Bogota',
      esperado: { mfr: 'Chainway', model: 'P80' }
    }
  ];

  let todosOk = true;
  for (const c of casosDePrueba) {
    const res = resolveModelFromImei(c.imei);
    const mfrOk = res && res.manufacturer.toLowerCase() === c.esperado.mfr.toLowerCase();
    const mdlOk = res && res.model.toLowerCase().includes(c.esperado.model.toLowerCase());

    if (mfrOk && mdlOk) {
      console.log(`   ✅ [${c.cliente}] IMEI: ${c.imei} ➔ Fabricante: "${res.manufacturer}", Modelo: "${res.model}"`);
    } else {
      console.log(`   ❌ [${c.cliente}] IMEI: ${c.imei} ➔ Error: Se obtuvo [${res?.manufacturer} / ${res?.model}]`);
      todosOk = false;
    }
  }

  // PRUEBA 5: Simulación de lo que recibe el Frontend (Tabla de la consola web)
  console.log('\n5. Simulación de lo que mostrará la tabla del Frontend:');
  console.log('---------------------------------------------------------------------------------------------------');
  console.log('| Identificador (IMEI)  | Modelo Comercial             | Fabricante  | Fecha de Alta en Zero-Touch |');
  console.log('---------------------------------------------------------------------------------------------------');

  for (const c of casosDePrueba) {
    const rowInCsv = rows.find(r => r.imei === c.imei);
    const res = resolveModelFromImei(c.imei);
    const fecha = rowInCsv ? rowInCsv.datetimeaddedutc : new Date().toISOString();

    const colImei = c.imei.padEnd(21);
    const colModel = (res ? res.model : 'Dispositivo').padEnd(28);
    const colMfr = (res ? res.manufacturer : 'N/A').padEnd(11);
    const colFecha = (fecha || '-').padEnd(27);

    console.log(`| ${colImei} | ${colModel} | ${colMfr} | ${colFecha} |`);
  }
  console.log('---------------------------------------------------------------------------------------------------\n');

  if (todosOk) {
    console.log('🎉 RESULTADO: TODAS LAS PRUEBAS PASARON AL 100% EXITOSAMENTE.');
    console.log('   La lógica funciona perfectamente sin romper nada y sin requerir tocar main.');
  } else {
    console.log('⚠️ Algunas pruebas tuvieron diferencias. Revisa los mensajes de arriba.');
  }
}

run().catch(console.error);
