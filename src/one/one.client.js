const { oneConfig } = require('./one.config');
const { cache, sha256 } = require('./one.cache');

/**
 * Función auxiliar para realizar peticiones HTTP a One con timeout.
 */
async function callOne(path, options = {}) {
  const url = `${oneConfig.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), oneConfig.timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) {
      const error = new Error(
        data?.message || data?.error || `Error en servicio One (HTTP ${response.status})`
      );
      error.statusCode = response.status;
      error.details = data;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Tiempo de espera agotado al conectar con el servicio One.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Endpoint 1: Validación de Sesión de Usuario (Consola SPA)
 * GET api/v1/auth/me
 * Cabecera: Authorization: Bearer <jwt_del_usuario>
 * Caché en memoria durante 15 s (un cierre de sesión en One se nota pronto) bajo one:me:<sha256(token)>.
 */
async function verifyUserToken(token) {
  if (!token) {
    const error = new Error('Token de usuario no proporcionado.');
    error.statusCode = 401;
    throw error;
  }

  const cacheKey = `one:me:${sha256(token)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const userData = await callOne('/api/v1/auth/me', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  // 15 s: con el cierre de sesión único de One, un token revocado deja de servir enseguida
  cache.set(cacheKey, userData, 15 * 1000);
  return userData;
}

/**
 * Endpoint 2: Verificación de Credenciales de Integración Externa
 * GET api/v1/integration/verify
 * Cabeceras: X-Api-Key, X-Api-Secret
 * Caché en memoria durante 2 minutos bajo one:cred:<sha256(key + "\n" + secret)>.
 * Reglas:
 * - Debe responder active === true
 * - appSlug debe coincidir con oneConfig.appSlug ("zero-touch")
 * - Si One responde 5xx, se retorna HTTP 503 (no 401) para permitir reintento.
 */
async function verifyIntegrationCredentials(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) {
    const error = new Error('Credenciales de integración incompletas (X-Api-Key y X-Api-Secret requeridos).');
    error.statusCode = 401;
    throw error;
  }

  const cacheKey = `one:cred:${sha256(`${apiKey}\n${apiSecret}`)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let result;
  try {
    result = await callOne('/api/v1/integration/verify', {
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Secret': apiSecret,
      },
    });
  } catch (error) {
    if (error.statusCode && error.statusCode >= 500) {
      const retryError = new Error('El servicio de integración One no está disponible temporalmente.');
      retryError.statusCode = 503;
      retryError.details = error.details;
      throw retryError;
    }
    throw error;
  }

  if (!result || !result.active) {
    const error = new Error('Credenciales de integración inactivas o revocadas.');
    error.statusCode = 401;
    throw error;
  }

  if (result.appSlug !== oneConfig.appSlug) {
    const error = new Error(
      `Credencial pertenece a la aplicación "${result.appSlug}", no a "${oneConfig.appSlug}".`
    );
    error.statusCode = 403;
    throw error;
  }

  // Guardar en caché por 2 minutos (120.000 ms)
  cache.set(cacheKey, result, 2 * 60 * 1000);
  return result;
}

/**
 * Endpoint 3: Catálogo de Empresas Asignadas a la App
 * GET api/v1/me/apps/{slug}/tenants (ej: api/v1/me/apps/zero-touch/tenants)
 * Cabecera: Authorization: Bearer <jwt_del_usuario>
 */
async function listUserAppTenants(token) {
  if (!token) {
    const error = new Error('Token de usuario no proporcionado.');
    error.statusCode = 401;
    throw error;
  }

  const tenants = await callOne(`/api/v1/me/apps/${oneConfig.appSlug}/tenants`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return Array.isArray(tenants) ? tenants : [];
}

/**
 * Endpoint 4: Configuración Dinámica de la Empresa (Settings)
 * GET api/v1/integration/config
 * Cabeceras: X-Api-Key, X-Api-Secret
 * Caché en memoria durante 5 minutos bajo one:config:{tenantCacheKey}.
 */
async function getTenantConfig(apiKey, apiSecret, tenantCacheKey = '') {
  if (!apiKey || !apiSecret) {
    const error = new Error('Faltan credenciales de One para consultar la configuración de la empresa.');
    error.statusCode = 400;
    throw error;
  }

  const keyIdentifier = tenantCacheKey || sha256(apiKey);
  const cacheKey = `one:config:${keyIdentifier}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const configData = await callOne('/api/v1/integration/config', {
    headers: {
      'X-Api-Key': apiKey,
      'X-Api-Secret': apiSecret,
    },
  });

  // Guardar en caché por 5 minutos (300.000 ms)
  cache.set(cacheKey, configData, 5 * 60 * 1000);
  return configData;
}

module.exports = {
  verifyUserToken,
  verifyIntegrationCredentials,
  listUserAppTenants,
  getTenantConfig,
};

