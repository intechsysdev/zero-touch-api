const { query } = require('./db');
const { config } = require('./config');
const { listCustomers } = require('./zerotouch/zerotouch.client');
const {
  detectSamsungCustomerById,
  isSamsungConfigured,
} = require('./samsung/samsung.client');

// Consultar Google y Knox en cada petición es lento y gasta cuota: lo encontrado se guarda en la
// empresa y se vuelve a mirar pasado este tiempo.
const VIGENCIA_MS = 60 * 60 * 1000;

function normalizarTexto(t) {
  return String(t || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function limpiarSufijosEmpresa(t) {
  return normalizarTexto(t)
    .replace(/\b(s\.?a\.?s\.?|s\.?a\.?|ltda\.?|inc\.?|corp\.?)\b/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Plataformas en las que existe el Client ID de una empresa.
 *
 * 1. Búsqueda por Client ID exacto (companyId numérico en Google).
 * 2. Si el Client ID es temporal (one:GUID generado automáticamente porque en One
 *    no se configuró la variable), busca coincidencia exacta por nombre de la empresa
 *    en Google Zero-touch y vincula automáticamente el companyId encontrado.
 */
async function detectarPlataformas(clientId, companyName = '') {
  const id = String(clientId || '').trim();
  const nombreNorm = normalizarTexto(companyName);
  const nombreLimpio = limpiarSufijosEmpresa(companyName);

  if (!id && !nombreNorm) {
    return { zeroTouchCustomerName: null, companyName: null, samsungCustomerId: null, detectedCompanyId: null };
  }

  let cliente = null;
  let zeroTouchError = null;
  try {
    const data = await listCustomers();
    const clientes = Array.isArray(data.customers) ? data.customers : [];

    // 1. Coincidencia por Client ID numérico (si no es el prefijo temporal one:...)
    if (id && !id.startsWith('one:')) {
      cliente = clientes.find((c) => String(c.companyId || '').trim() === id) || null;
    }

    // 2. Coincidencia por nombre exacto si el Client ID es temporal (one:...) o no coincidió
    if (!cliente && nombreNorm) {
      cliente = clientes.find((c) => normalizarTexto(c.companyName) === nombreNorm) || null;
    }

    // 3. Coincidencia por nombre limpio (sin S.A., S.A.S., etc.)
    if (!cliente && nombreLimpio && nombreLimpio.length >= 3) {
      cliente = clientes.find((c) => limpiarSufijosEmpresa(c.companyName) === nombreLimpio) || null;
    }
  } catch (error) {
    zeroTouchError = error.message;
    console.warn(`No se pudo consultar Zero-touch para el Client ID ${id}:`, error.message);
  }

  let samsungCustomerId = null;
  if (isSamsungConfigured()) {
    try {
      samsungCustomerId = await detectSamsungCustomerById(id);
    } catch (error) {
      console.warn(`No se pudo consultar Samsung Knox para el Client ID ${id}:`, error.message);
    }
  }
  if (!samsungCustomerId && (config.samsungKnoxAllowedCustomerIds || []).includes(id)) {
    samsungCustomerId = id;
  }

  return {
    zeroTouchCustomerName: cliente?.name ? String(cliente.name) : null,
    companyName: cliente?.companyName ? String(cliente.companyName) : null,
    samsungCustomerId,
    detectedCompanyId: cliente?.companyId ? String(cliente.companyId) : null,
    zeroTouchError,
  };
}

/**
 * Deja al día las plataformas de la empresa (fila de `clients`) y devuelve la fila actualizada.
 * Con `forzar` no espera a que venza lo guardado.
 */
async function asegurarPlataformas(client, { forzar = false } = {}) {
  if (!client?.id || !client.client_id) return client;

  // Si ya tiene datos y el caché es reciente no se vuelve a consultar.
  // Si zero_touch_customer_name está vacío se fuerza siempre la detección:
  // el caché de 1 hora solo protege datos que ya existen.
  const sinDatos = !client.zero_touch_customer_name;
  const verificadas = client.plataformas_verificadas_at
    ? new Date(client.plataformas_verificadas_at).getTime()
    : 0;
  if (!forzar && !sinDatos && Date.now() - verificadas < VIGENCIA_MS) return client;

  const encontrado = await detectarPlataformas(client.client_id, client.company_name);
  const nuevoClientId = encontrado.detectedCompanyId;

  // Si Google no respondió no se borra lo que ya se sabía: mejor un dato de hace una hora que
  // dejar a la empresa sin plataforma por un corte.
  // Si el client_id actual es temporal (one:GUID) y Google tiene el companyId numérico real,
  // se actualiza client_id para vincular la empresa definitivamente.
  const result = await query(
    `
      UPDATE clients
      SET zero_touch_customer_name = COALESCE(@customerName, zero_touch_customer_name),
          client_id = CASE
            WHEN client_id LIKE 'one:%' AND @nuevoClientId IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM clients WHERE client_id = @nuevoClientId AND id != @id)
            THEN @nuevoClientId
            ELSE client_id
          END,
          samsung_customer_id = @samsungCustomerId,
          plataformas_verificadas_at = SYSUTCDATETIME()
      OUTPUT INSERTED.*
      WHERE id = @id
    `,
    {
      customerName: encontrado.zeroTouchCustomerName,
      nuevoClientId: nuevoClientId || null,
      samsungCustomerId: encontrado.samsungCustomerId,
      id: String(client.id),
    }
  );

  const updated = result.rows[0] || client;
  if (encontrado.zeroTouchError) {
    updated._zeroTouchError = encontrado.zeroTouchError;
  }
  return updated;
}

/** Lo que la consola necesita saber de las plataformas de una empresa. */
function resumenPlataformas(client) {
  const zeroTouchCustomerName = client?.zero_touch_customer_name || null;
  return {
    zeroTouchAvailable: Boolean(zeroTouchCustomerName),
    zeroTouchCustomerName,
    zeroTouchCustomerId: zeroTouchCustomerName ? String(zeroTouchCustomerName).split('/').pop() : null,
    samsungAvailable: Boolean(client?.samsung_customer_id),
    samsungCustomerId: client?.samsung_customer_id || null,
  };
}

module.exports = {
  detectarPlataformas,
  asegurarPlataformas,
  resumenPlataformas,
};
