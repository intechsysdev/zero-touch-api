/**
 * tac-resolver.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Resuelve el fabricante y modelo de un dispositivo a partir de su TAC
 * (Type Allocation Code, los primeros 8 dígitos del IMEI).
 *
 * En Google Zero-touch, cuando los dispositivos se enrolan por IMEI, la API
 * de partners de Google solo almacena el IMEI y no enriquece el modelo ni el
 * fabricante en la respuesta REST. Este módulo completa esa información
 * automáticamente a partir del código de homologación GSMA (TAC).
 */

// Catálogo de TACs frecuentes (primeros 8 dígitos de IMEI) registrados en Intechsys
const TAC_CATALOG = {
  // ─── SAMSUNG ──────────────────────────────────────────────────────────────
  '35455593': { manufacturer: 'Samsung', model: 'Galaxy A27 5G' },
  '35005771': { manufacturer: 'Samsung', model: 'Galaxy A35 5G' },
  '35112390': { manufacturer: 'Samsung', model: 'Galaxy A34 5G (SM-A346M)' },
  '35140746': { manufacturer: 'Samsung', model: 'Galaxy S24+ (SM-S926)' },
  '35286257': { manufacturer: 'Samsung', model: 'Galaxy Tab A9+ (SM-X216)' },
  '35735814': { manufacturer: 'Samsung', model: 'Galaxy Tab A9+ (SM-X216)' },
  '35433876': { manufacturer: 'Samsung', model: 'Galaxy Tab A7 Lite (SM-T225)' },
  '35629831': { manufacturer: 'Samsung', model: 'Galaxy Tab Active3 (SM-T575)' },
  '35439911': { manufacturer: 'Samsung', model: 'Galaxy S20 (SM-G980F)' },
  '35428965': { manufacturer: 'Samsung', model: 'Galaxy A04s / A14' },
  '35837234': { manufacturer: 'Samsung', model: 'Galaxy A37 5G' },
  '35251693': { manufacturer: 'Samsung', model: 'Galaxy A series' },
  '35777864': { manufacturer: 'Samsung', model: 'Galaxy Tab A series' },
  '35136828': { manufacturer: 'Samsung', model: 'Galaxy A series' },
  '35263294': { manufacturer: 'Samsung', model: 'Galaxy A series' },
  '35287122': { manufacturer: 'Samsung', model: 'Galaxy A series' },
  '35341411': { manufacturer: 'Samsung', model: 'Galaxy A series' },
  '35341511': { manufacturer: 'Samsung', model: 'Galaxy A series' },
  '35459822': { manufacturer: 'Samsung', model: 'Galaxy A series' },
  '35491155': { manufacturer: 'Samsung', model: 'Galaxy A series' },

  // ─── LENOVO ───────────────────────────────────────────────────────────────
  '86489206': { manufacturer: 'Lenovo', model: 'Tab M11 LTE (TB330XU / TB311XU)' },
  '86064606': { manufacturer: 'Lenovo', model: 'Tab M10 3rd Gen (TB128XU)' },
  '86394505': { manufacturer: 'Lenovo', model: 'Tab M10 Plus (TB125FU / TB-X606)' },

  // ─── CHAINWAY (Terminales robustas / Colectoras) ───────────────────────────
  '86000304': { manufacturer: 'Chainway', model: 'P80 Rugged Tablet' },
  '86441304': { manufacturer: 'Chainway', model: 'C66 / C72 Mobile Computer' },
  '86407504': { manufacturer: 'Chainway', model: 'C66 Handheld Barcode Terminal' },
  '86872704': { manufacturer: 'Chainway', model: 'C61 / C70 Mobile Computer' },

  // ─── HONEYWELL (Colectoras de datos empresariales) ─────────────────────────
  '99001194': { manufacturer: 'Honeywell', model: 'ScanPal EDA51 Mobile Computer' },
  '99001770': { manufacturer: 'Honeywell', model: 'ScanPal EDA52 / EDA50 Mobile Computer' },
  '99001845': { manufacturer: 'Honeywell', model: 'ScanPal EDA5S Mobile Computer' },
  '99002191': { manufacturer: 'Honeywell', model: 'ScanPal EDA52 Enterprise Terminal' },

  // ─── XIAOMI / REDMI ───────────────────────────────────────────────────────
  '86237807': { manufacturer: 'Xiaomi', model: 'Redmi Note 14 (24117RN76L)' },
  '86395407': { manufacturer: 'Xiaomi', model: 'Redmi Note 14 (24117RN76L)' },
  '86370706': { manufacturer: 'Xiaomi', model: 'Redmi Note 12S (2303ERA42L)' },
  '86924407': { manufacturer: 'Xiaomi', model: 'Redmi Note 13 4G (23129RAA4G)' },
  '86911306': { manufacturer: 'Xiaomi', model: 'Redmi Note 11 (2201117TL)' },
  '86560707': { manufacturer: 'Xiaomi', model: 'Redmi Note 13 Pro 4G' },
  '86404806': { manufacturer: 'Xiaomi', model: 'Redmi 12 / 13C 4G' },
  '86316406': { manufacturer: 'Xiaomi', model: 'Redmi 10C / 12C' },
  '86632607': { manufacturer: 'Xiaomi', model: 'Redmi Note 13 Series' },
  '86244107': { manufacturer: 'Xiaomi', model: 'Redmi Note series' },
  '86711006': { manufacturer: 'Xiaomi', model: 'Redmi series' },

  // ─── MOTOROLA ─────────────────────────────────────────────────────────────
  '35007738': { manufacturer: 'Motorola', model: 'Moto G41 (XT2167-1)' },
  '35461245': { manufacturer: 'Motorola', model: 'Edge 50 Fusion (XT2429)' },
  '35723170': { manufacturer: 'Motorola', model: 'Moto G84 5G (XT2347)' },
  '35367135': { manufacturer: 'Motorola', model: 'Moto G32 (XT2235)' },
  '35530264': { manufacturer: 'Motorola', model: 'Moto G52 / G53' },
  '35408116': { manufacturer: 'Motorola', model: 'Moto G series' },
  '35218210': { manufacturer: 'Motorola', model: 'Moto G series' },

  // ─── HMD GLOBAL / NOKIA ───────────────────────────────────────────────────
  '35350685': { manufacturer: 'HMD Global', model: 'Nokia G21 (TA-1418)' },
  '35874257': { manufacturer: 'HMD Global', model: 'Nokia G10 (TA-1334)' },

  // ─── OTROS FABRICANTES FRECUENTES ─────────────────────────────────────────
  '35984160': { manufacturer: 'Ulefone', model: 'Armor X10 Pro Rugged' },
  '35032311': { manufacturer: 'Blackview', model: 'Tab 60 Kids' },
  '35338910': { manufacturer: 'LG Electronics', model: 'LG K series' },
  '86534607': { manufacturer: 'Huawei', model: 'Nova Y70 / Y90' },
};

// Prefijos más amplios (primeros 6 dígitos) para identificar al menos la marca
const PREFIX_6_MANUFACTURERS = {
  // Samsung
  '350057': 'Samsung',
  '351123': 'Samsung',
  '351407': 'Samsung',
  '352862': 'Samsung',
  '357358': 'Samsung',
  '354338': 'Samsung',
  '356298': 'Samsung',
  '354399': 'Samsung',
  '354555': 'Samsung',
  '358372': 'Samsung',
  '352516': 'Samsung',
  '352632': 'Samsung',
  '352871': 'Samsung',
  '353414': 'Samsung',
  '353415': 'Samsung',
  '354598': 'Samsung',
  '354911': 'Samsung',

  // Lenovo
  '864892': 'Lenovo',
  '860646': 'Lenovo',
  '863945': 'Lenovo',

  // Chainway
  '860003': 'Chainway',
  '864413': 'Chainway',
  '864075': 'Chainway',
  '868727': 'Chainway',

  // Honeywell
  '990011': 'Honeywell',
  '990017': 'Honeywell',
  '990018': 'Honeywell',
  '990021': 'Honeywell',

  // Xiaomi
  '862378': 'Xiaomi',
  '863954': 'Xiaomi',
  '863707': 'Xiaomi',
  '869244': 'Xiaomi',
  '869113': 'Xiaomi',
  '865607': 'Xiaomi',
  '864048': 'Xiaomi',
  '863164': 'Xiaomi',
  '866326': 'Xiaomi',
  '862441': 'Xiaomi',
  '867110': 'Xiaomi',

  // Motorola
  '350077': 'Motorola',
  '354612': 'Motorola',
  '357231': 'Motorola',
  '353671': 'Motorola',
  '355302': 'Motorola',
  '354081': 'Motorola',
  '352182': 'Motorola',

  // HMD Global / Nokia
  '353506': 'HMD Global',
  '358742': 'HMD Global',

  // Huawei
  '865346': 'Huawei',
};

/**
 * Resuelve fabricante y modelo a partir de un IMEI de 14 a 16 dígitos.
 * @param {string} imei
 * @returns {{ manufacturer: string | null, model: string | null }}
 */
function resolveDeviceInfoFromImei(imei) {
  const cleanImei = String(imei || '').trim().replace(/\D/g, '');
  if (cleanImei.length < 6) {
    return { manufacturer: null, model: null };
  }

  // 1. Coincidencia exacta por TAC completo de 8 dígitos
  if (cleanImei.length >= 8) {
    const tac8 = cleanImei.slice(0, 8);
    if (TAC_CATALOG[tac8]) {
      return {
        manufacturer: TAC_CATALOG[tac8].manufacturer,
        model: TAC_CATALOG[tac8].model,
      };
    }
  }

  // 2. Coincidencia por prefijo de fabricante (6 dígitos)
  const tac6 = cleanImei.slice(0, 6);
  if (PREFIX_6_MANUFACTURERS[tac6]) {
    const manufacturer = PREFIX_6_MANUFACTURERS[tac6];
    return {
      manufacturer,
      model: `${manufacturer} Dispositivo`,
    };
  }

  return { manufacturer: null, model: null };
}

module.exports = {
  resolveDeviceInfoFromImei,
  TAC_CATALOG,
  PREFIX_6_MANUFACTURERS,
};
