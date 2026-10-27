/**
 * csv-import.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Parsea el CSV que Google exporta desde el portal de Zero-touch Reseller
 * (partner.android.com → Devices → Download results as .csv) y actualiza
 * la tabla client_devices con el modelo y fabricante reales.
 *
 * Columnas esperadas en el CSV de Google (sin importar el orden):
 *   imei, imei2, serialnumber, manufacturer, model,
 *   derivedmanufacturer, owner, ownername, reseller, resellername
 *
 * El CSV puede traer también columnas extra que se ignoran silenciosamente.
 */

let dbModule = null;
function getDb() {
  if (!dbModule) {
    try {
      dbModule = require('../db');
    } catch (_) {}
  }
  return dbModule;
}
const { learnFromCsvRows, normalizeManufacturer } = require('./device-catalog');

/**
 * Parsea un CSV simple (RFC-4180): maneja comillas dobles y saltos dentro de campos.
 * No requiere ninguna librería externa.
 *
 * @param {string} text  Contenido completo del archivo CSV (UTF-8)
 * @returns {{ headers: string[], rows: object[] }}
 */
function parseCsv(text) {
  // Normalizar saltos de línea
  const content = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);

  // Separar campos de una línea ya sin saltos dentro de campos
  function splitLine(line) {
    const fields = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { field += '"'; i++; }
        else { inQ = !inQ; }
      } else if (ch === ',' && !inQ) {
        fields.push(field.trim());
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field.trim());
    return fields;
  }

  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = splitLine(nonEmpty[0]).map((h) => h.toLowerCase().trim());
  const rows = nonEmpty.slice(1).map((line) => {
    const values = splitLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] || '').trim();
    });
    return row;
  });

  return { headers, rows };
}

/**
 * Actualiza la base de datos con los datos del CSV de Google.
 * Solo actualiza filas que ya existen en client_devices (por IMEI o serial).
 * No inserta filas nuevas: el sync normal se encarga de eso.
 *
 * @param {number} clientDbId  ID interno de la empresa en la DB
 * @param {string} csvText     Contenido del archivo CSV descargado de Google
 * @returns {{ updated: number, skipped: number, unmatched: number, errors: string[] }}
 */
async function importGoogleCsv(clientDbId, csvText) {
  const { rows } = parseCsv(csvText);

  // Auto-aprender todos los modelos de hardware presentes en el CSV
  let catalogResult = { learnedCount: 0, totalInCatalog: 0 };
  try {
    catalogResult = await learnFromCsvRows(rows);
  } catch (catalogErr) {
    console.warn('Error auto-aprendiendo catálogo desde CSV:', catalogErr.message);
  }

  const db = getDb();
  if (!db) {
    throw new Error('Base de datos no disponible');
  }

  let updated = 0;
  let skipped = 0;
  let unmatched = 0;
  const errors = [];

  const BATCH_SIZE = 15;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(
      chunk.map(async (row) => {
        try {
          const imei = (row['imei'] || row['modemid'] || '').replace(/\D/g, '').slice(0, 15) || null;
          const serial = row['serialnumber'] || row['serial'] || null;
          // Google puede poner el fabricante en "manufacturer" o en "derivedmanufacturer"
          const rawMfr = row['manufacturer'] || row['derivedmanufacturer'] || null;
          const manufacturer = normalizeManufacturer(rawMfr);
          const model = row['model'] || row['derivedmodel'] || null;

          // Fecha de adición/creación en Google Zero-touch (columna 'datetimeaddedutc')
          const rawDate = row['datetimeaddedutc'] || row['dateadded'] || row['createdtime'] || row['created'] || null;
          let dateAdded = null;
          if (rawDate) {
            const d = new Date(rawDate.includes('T') ? rawDate : rawDate.replace(' ', 'T') + 'Z');
            if (!isNaN(d.getTime())) {
              dateAdded = d.toISOString();
            }
          }

          if (!imei && !serial) {
            skipped++;
            return;
          }

          if (!manufacturer && !model && !dateAdded) {
            skipped++;
            return;
          }

          // Intentar actualizar por IMEI primero, luego por serial
          let rowsAffected = 0;

          if (imei) {
            const result = await db.query(
              `
              UPDATE client_devices
              SET
                manufacturer = COALESCE(@manufacturer, manufacturer),
                model        = COALESCE(@model, model),
                synced_at    = COALESCE(TRY_CONVERT(DATETIME2, @dateAdded), synced_at),
                updated_at   = SYSUTCDATETIME()
              WHERE (@clientDbId IS NULL OR @clientDbId = 0 OR client_db_id = @clientDbId)
                AND imei = @imei
              `,
              {
                clientDbId: { tipo: db.sql.Int, valor: Number(clientDbId) || 0 },
                imei: { tipo: db.sql.NVarChar(50), valor: imei },
                manufacturer: { tipo: db.sql.NVarChar(200), valor: manufacturer },
                model: { tipo: db.sql.NVarChar(200), valor: model },
                dateAdded: { tipo: db.sql.NVarChar(50), valor: dateAdded },
              }
            );
            rowsAffected = result.rowsAffected || 0;
          }

          if (!rowsAffected && serial) {
            const result = await db.query(
              `
              UPDATE client_devices
              SET
                manufacturer = COALESCE(@manufacturer, manufacturer),
                model        = COALESCE(@model, model),
                synced_at    = COALESCE(TRY_CONVERT(DATETIME2, @dateAdded), synced_at),
                updated_at   = SYSUTCDATETIME()
              WHERE (@clientDbId IS NULL OR @clientDbId = 0 OR client_db_id = @clientDbId)
                AND serial_number = @serial
              `,
              {
                clientDbId: { tipo: db.sql.Int, valor: Number(clientDbId) || 0 },
                serial: { tipo: db.sql.NVarChar(200), valor: serial },
                manufacturer: { tipo: db.sql.NVarChar(200), valor: manufacturer },
                model: { tipo: db.sql.NVarChar(200), valor: model },
                dateAdded: { tipo: db.sql.NVarChar(50), valor: dateAdded },
              }
            );
            rowsAffected = result.rowsAffected || 0;
          }

          if (rowsAffected > 0) {
            updated++;
          } else {
            unmatched++;
          }
        } catch (err) {
          errors.push(`Row error: ${err.message}`);
        }
      })
    );
  }

  return {
    updated,
    skipped,
    unmatched,
    errors,
    totalRows: rows.length,
    modelsLearned: catalogResult.learnedCount,
    totalCatalogModels: catalogResult.totalInCatalog,
  };
}

module.exports = { importGoogleCsv, parseCsv };

