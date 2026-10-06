const { pool } = require('./db');
const { config } = require('./config');
const { listCustomers } = require('./zerotouch/zerotouch.client');
const {
  detectSamsungCustomerById,
  isSamsungConfigured,
} = require('./samsung/samsung.client');

// Consultar Google y Knox en cada petición es lento y gasta cuota: lo encontrado se guarda en la
// empresa y se vuelve a mirar pasado este tiempo.
const VIGENCIA_MS = 60 * 60 * 1000;

/**
 * Plataformas en las que existe el Client ID de una empresa. El Client ID es el que la empresa
 * tiene en One (la variable que la identifica en la app zero-touch), y es el mismo número con el
 * que el cliente aparece en Google Zero-touch (companyId) o en Samsung Knox.
 *
 * La coincidencia es exacta: con nombres parecidos una empresa podría terminar viendo los equipos
 * de otra.
 */
async function detectarPlataformas(clientId) {
  const id = String(clientId || '').trim();
  if (!id) {
    return { zeroTouchCustomerName: null, companyName: null, samsungCustomerId: null };
  }

  let cliente = null;
  try {
    const data = await listCustomers();
    const clientes = Array.isArray(data.customers) ? data.customers : [];
    cliente = clientes.find((c) => String(c.companyId || '').trim() === id) || null;
  } catch (error) {
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
  };
}

/**
 * Deja al día las plataformas de la empresa (fila de `clients`) y devuelve la fila actualizada.
 * Con `forzar` no espera a que venza lo guardado.
 */
async function asegurarPlataformas(client, { forzar = false } = {}) {
  if (!client?.id || !client.client_id) return client;

  const verificadas = client.plataformas_verificadas_at
    ? new Date(client.plataformas_verificadas_at).getTime()
    : 0;
  if (!forzar && Date.now() - verificadas < VIGENCIA_MS) return client;

  const encontrado = await detectarPlataformas(client.client_id);

  // Si Google no respondió no se borra lo que ya se sabía: mejor un dato de hace una hora que
  // dejar a la empresa sin plataforma por un corte.
  const result = await pool.query(
    `
      UPDATE clients
      SET zero_touch_customer_name = COALESCE($1, zero_touch_customer_name),
          samsung_customer_id = $2,
          plataformas_verificadas_at = now()
      WHERE id = $3
      RETURNING *
    `,
    [encontrado.zeroTouchCustomerName, encontrado.samsungCustomerId, client.id]
  );

  return result.rows[0] || client;
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
