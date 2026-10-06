const express = require('express');
const { oneConfig } = require('../one');

const router = express.Router();

/**
 * Reenvía a One las dos llamadas del SSO que hace la consola sin sesión de zero-touch: canjear el
 * código por la sesión y cerrarla. Pasan por aquí, de servidor a servidor, para que la consola no
 * dependa de estar en la lista de orígenes (CORS) de One. No se guarda nada: lo que One responde
 * es lo que recibe la consola.
 */
async function reenviar(res, ruta, cuerpo, authorization) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), oneConfig.timeoutMs);

  try {
    const response = await fetch(`${oneConfig.baseUrl}${ruta}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(cuerpo),
      signal: controller.signal,
    });

    const texto = await response.text();
    res.status(response.status);
    if (!texto) return res.end();
    res.type(response.headers.get('content-type') || 'application/json').send(texto);
  } catch (error) {
    const agotado = error.name === 'AbortError';
    res.status(agotado ? 504 : 502).json({
      message: agotado
        ? 'Tiempo de espera agotado al conectar con el servicio One.'
        : 'No se pudo conectar con el servicio One.',
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// POST /api/v1/sso/token { clientId, code, codeVerifier, redirectUri }
router.post('/token', (req, res) => {
  const { clientId, code, codeVerifier, redirectUri } = req.body || {};
  if (clientId !== oneConfig.appSlug) {
    return res.status(400).json({ message: `Este canje es solo para la app ${oneConfig.appSlug}.` });
  }
  return reenviar(res, '/api/v1/sso/token', { clientId, code, codeVerifier, redirectUri });
});

// POST /api/v1/sso/logout { refreshToken } con el token de la sesión
router.post('/logout', (req, res) => {
  const { refreshToken } = req.body || {};
  return reenviar(res, '/api/v1/auth/logout', { refreshToken }, req.headers.authorization);
});

module.exports = { ssoRouter: router };
