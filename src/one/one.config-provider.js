const { getTenantConfig } = require('./one.client');
const { getClientOneCredentials, getClientByDbId } = require('../db');

/**
 * Proveedor de Configuración Dinámica por Empresa desde One.
 * Equivalente a ProveedorConfiguracionOne.cs en .NET.
 *
 * Flujo:
 * 1. Lee las credenciales de One (OneApiKey y OneApiSecret) asociadas a la empresa.
 * 2. Consulta GET api/v1/integration/config en One con caché de 5 minutos.
 * 3. Mapea el diccionario de settings a propiedades tipadas:
 *    - ZERO_TOUCH_CUSTOMER_ID
 *    - ZERO_TOUCH_CUSTOMER_NAME
 *    - SAMSUNG_KNOX_CUSTOMER_ID
 *    - SAMSUNG_KNOX_PROFILE_ID
 */
async function getCompanyDynamicConfig(clientDbId) {
  if (!clientDbId) return null;

  // 1. Obtener credenciales de integración de la empresa
  const creds = await getClientOneCredentials(clientDbId);
  if (!creds || !creds.one_api_key || !creds.one_api_secret) {
    return null;
  }

  try {
    // 2. Consultar a One (con caché automático de 5 min)
    const configData = await getTenantConfig(
      creds.one_api_key,
      creds.one_api_secret,
      String(clientDbId)
    );

    const settings = configData?.settings || {};

    const zeroTouchCustomerId =
      settings.ZERO_TOUCH_CUSTOMER_ID ||
      settings.ZERO_TOUCH_CUSTOMER ||
      settings.CUSTOMER_ID ||
      null;

    const zeroTouchCustomerName =
      settings.ZERO_TOUCH_CUSTOMER_NAME ||
      (zeroTouchCustomerId ? `customers/${zeroTouchCustomerId}` : null);

    return {
      tenant: configData?.tenant || null,
      zeroTouchCustomerId: zeroTouchCustomerId ? String(zeroTouchCustomerId).trim() : null,
      zeroTouchCustomerName: zeroTouchCustomerName ? String(zeroTouchCustomerName).trim() : null,
      samsungCustomerId: settings.SAMSUNG_KNOX_CUSTOMER_ID || null,
      samsungProfileId: settings.SAMSUNG_KNOX_PROFILE_ID || null,
      rawSettings: settings,
      configVersion: configData?.configVersion || '1.0',
    };
  } catch (error) {
    console.warn(`No se pudo obtener configuración dinámica de One para empresa ${clientDbId}:`, error.message);
    return null;
  }
}

module.exports = {
  getCompanyDynamicConfig,
};

