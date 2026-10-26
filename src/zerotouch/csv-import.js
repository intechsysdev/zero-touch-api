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

const { query } = require('../db');
const sql = require('mssql');

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
 * Normaliza el texto de fabricante y modelo tal como lo entrega Google en el CSV.
 * Google a veces exporta el fabricante en minúsculas o con notación interna.
 */
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
  const lower = raw.toLowerCase().trim();
  return map[lower] || raw.trim();
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

  let updated = 0;
  let skipped = 0;
  let unmatched = 0;
  const errors = [];

  for (const row of rows) {
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
        continue;
      }

      if (!manufacturer && !model && !dateAdded) {
        skipped++;
        continue;
      }

      // Intentar actualizar por IMEI primero, luego por serial
      let rowsAffected = 0;

      if (imei) {
        const result = await query(
          `
          UPDATE client_devices
          SET
            manufacturer = COALESCE(@manufacturer, manufacturer),
            model        = COALESCE(@model, model),
            synced_at    = COALESCE(TRY_CONVERT(DATETIME2, @dateAdded), synced_at),
            updated_at   = SYSUTCDATETIME()
          WHERE client_db_id = @clientDbId
            AND imei = @imei
          `,
          {
            clientDbId: { tipo: sql.Int, valor: Number(clientDbId) },
            imei: { tipo: sql.NVarChar(50), valor: imei },
            manufacturer: { tipo: sql.NVarChar(200), valor: manufacturer },
            model: { tipo: sql.NVarChar(200), valor: model },
            dateAdded: { tipo: sql.NVarChar(50), valor: dateAdded },
          }
        );
        rowsAffected = result.rowsAffected || 0;
      }

      if (!rowsAffected && serial) {
        const result = await query(
          `
          UPDATE client_devices
          SET
            manufacturer = COALESCE(@manufacturer, manufacturer),
            model        = COALESCE(@model, model),
            synced_at    = COALESCE(TRY_CONVERT(DATETIME2, @dateAdded), synced_at),
            updated_at   = SYSUTCDATETIME()
          WHERE client_db_id = @clientDbId
            AND serial_number = @serial
          `,
          {
            clientDbId: { tipo: sql.Int, valor: Number(clientDbId) },
            serial: { tipo: sql.NVarChar(200), valor: serial },
            manufacturer: { tipo: sql.NVarChar(200), valor: manufacturer },
            model: { tipo: sql.NVarChar(200), valor: model },
            dateAdded: { tipo: sql.NVarChar(50), valor: dateAdded },
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
  }

  return { updated, skipped, unmatched, errors, totalRows: rows.length };
}

module.exports = { importGoogleCsv, parseCsv };

