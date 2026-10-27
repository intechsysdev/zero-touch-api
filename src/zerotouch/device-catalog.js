/**
 * device-catalog.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Catálogo auto-aprendido de modelos de dispositivos por TAC (primeros 8 dígitos de IMEI).
 *
 * Funciona de la siguiente forma:
 * 1. Inicializa con el catálogo oficial extraído del CSV de Google (103 modelos oficiales).
 * 2. Carga en memoria y sincroniza con la tabla dbo.device_model_catalog en base de datos.
 * 3. Cada vez que se importa un nuevo CSV de Google, APRENDE automáticamente cualquier
 *    modelo nuevo y lo persiste en la base de datos y memoria.
 * 4. Cuando entra un equipo NUEVO por IMEI (enrolado hoy o en el futuro), se consulta
 *    este catálogo y se le asigna su fabricante y modelo comercial real de inmediato.
 */

const path = require('path');
const fs = require('fs');

let dbModule = null;
function getDb() {
  if (!dbModule) {
    try {
      dbModule = require('../db');
    } catch (_) {}
  }
  return dbModule;
}

// Cargar catálogo inicial base
let initialEntries = {};
try {
  const jsonPath = path.join(__dirname, 'initial-catalog.json');
  if (fs.existsSync(jsonPath)) {
    initialEntries = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  }
} catch (e) {
  console.warn('No se pudo cargar initial-catalog.json:', e.message);
}

// Caché en memoria para resolución ultra rápida O(1)
const catalogMap = new Map();

// Cargar catálogo inicial en memoria
for (const [tac, data] of Object.entries(initialEntries)) {
  if (tac && data && data.manufacturer && data.model) {
    catalogMap.set(String(tac).trim(), {
      manufacturer: data.manufacturer,
      model: data.model,
    });
  }
}

/** Normaliza nombres de fabricantes comunes */
function normalizeManufacturer(raw) {
  if (!raw) return null;
  const map = {
    lenovo: 'Lenovo',
    samsung: 'Samsung',
    motorola: 'Motorola',
    xiaomi: 'Xiaomi',
    redmi: 'Xiaomi',
    huawei: 'Huawei',
    honeywell: 'Honeywell',
    chainway: 'Chainway',
    lg: 'LG',
    lge: 'LG',
    nokia: 'HMD Global',
    'hmd global': 'HMD Global',
    ulefone: 'Ulefone',
    blackview: 'Blackview',
    zebra: 'Zebra',
  };
  const lower = String(raw).toLowerCase().trim();
  return map[lower] || String(raw).trim();
}

/**
 * Resuelve el fabricante y modelo a partir de un IMEI de 14 a 16 dígitos.
 * @param {string} imei
 * @returns {{ manufacturer: string, model: string } | null}
 */
function resolveModelFromImei(imei) {
  const cleanImei = String(imei || '').trim().replace(/\D/g, '');
  if (cleanImei.length < 8) return null;

  const tac = cleanImei.slice(0, 8);
  if (catalogMap.has(tac)) {
    return catalogMap.get(tac);
  }

  return null;
}

/**
 * Carga los modelos almacenados en la base de datos dbo.device_model_catalog
 * al mapa en memoria (se llama al iniciar el servidor).
 */
async function loadCatalogFromDb() {
  const db = getDb();
  if (!db) return;

  try {
    const res = await db.query(`
      SELECT tac, manufacturer, model
      FROM dbo.device_model_catalog
    `);
    if (res && Array.isArray(res.rows)) {
      for (const row of res.rows) {
        if (row.tac && row.manufacturer && row.model) {
          catalogMap.set(String(row.tac).trim(), {
            manufacturer: row.manufacturer,
            model: row.model,
          });
        }
      }
    }
  } catch (err) {
    // Si la tabla aún no existe o no hay conexión, se mantiene el catálogo inicial
    console.warn('Advertencia al cargar catálogo desde DB:', err.message);
  }
}

/**
 * Extrae y aprende automáticamente los modelos de dispositivos presentes en las filas de un CSV.
 * Guarda los nuevos modelos en memoria y en la tabla dbo.device_model_catalog.
 *
 * @param {Array<object>} rows  Filas parseadas del CSV de Google
 * @returns {Promise<{ learnedCount: number, totalInCatalog: number }>}
 */
async function learnFromCsvRows(rows) {
  let learnedCount = 0;
  const toUpsert = [];

  for (const r of rows) {
    const imei = String(r['imei'] || r['modemid'] || '').replace(/\D/g, '');
    if (imei.length < 8) continue;

    const tac = imei.slice(0, 8);
    const rawMfr = r['manufacturer'] || r['derivedmanufacturer'];
    const manufacturer = normalizeManufacturer(rawMfr);
    const model = (r['model'] || r['derivedmodel'] || '').trim();

    if (!manufacturer || !model) continue;

    const existing = catalogMap.get(tac);
    if (!existing || existing.manufacturer !== manufacturer || existing.model !== model) {
      catalogMap.set(tac, { manufacturer, model });
      toUpsert.push({ tac, manufacturer, model });
      learnedCount++;
    }
  }

  // Persistir en base de datos los modelos aprendidos si hay conexión DB
  const db = getDb();
  if (db && toUpsert.length > 0) {
    for (const item of toUpsert) {
      try {
        await db.query(
          `
          UPDATE dbo.device_model_catalog
          SET manufacturer = @manufacturer,
              model = @model,
              updated_at = SYSUTCDATETIME()
          WHERE tac = @tac;

          IF @@ROWCOUNT = 0
            INSERT INTO dbo.device_model_catalog (tac, manufacturer, model, source, updated_at)
            VALUES (@tac, @manufacturer, @model, 'google_csv', SYSUTCDATETIME());
          `,
          {
            tac: { tipo: db.sql.NVarChar(8), valor: item.tac },
            manufacturer: { tipo: db.sql.NVarChar(200), valor: item.manufacturer },
            model: { tipo: db.sql.NVarChar(200), valor: item.model },
          }
        );
      } catch (err) {
        console.warn(`No se pudo persistir TAC ${item.tac} en DB:`, err.message);
      }
    }
  }

  return {
    learnedCount,
    totalInCatalog: catalogMap.size,
  };
}

module.exports = {
  resolveModelFromImei,
  learnFromCsvRows,
  loadCatalogFromDb,
  normalizeManufacturer,
  catalogMap,
};
