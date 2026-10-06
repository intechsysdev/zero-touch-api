const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { verifyUserToken } = require('../one');

/**
 * Middleware de Autenticación delegada en One.
 * Equivalente a ManejadorAutenticacionOne.cs en .NET.
 *
 * Flujo:
 * 1. Recibe 'Authorization: Bearer <token>'
 * 2. Consulta a One (GET api/v1/auth/me) con caché de 1 minuto (por sha256 de token)
 * 3. NO valida firmas JWT localmente para evitar exponer secretos en este repositorio.
 * 4. Construye req.user y req.auth con claims estándar y memberships.
 * 5. Soporte híbrido: si falla One, verifica si es un token local emitido previamente
 *    para mantener retrocompatibilidad durante la transición.
 */
async function requireAuth(req, res, next) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.substring('Bearer '.length).trim()
    : null;

  if (!token) {
    return res.status(401).json({ message: 'Missing bearer token.' });
  }

  // 1. Intentar validar contra One
  try {
    const userData = await verifyUserToken(token);
    if (userData && (userData.id || userData.email)) {
      const isPlatformAdmin = Boolean(
        userData.isPlatformAdmin ||
          (Array.isArray(userData.roles) && userData.roles.includes('PlatformAdmin'))
      );

      const memberships = Array.isArray(userData.memberships) ? userData.memberships : [];

      req.user = {
        id: userData.id,
        email: userData.email,
        fullName: userData.fullName || userData.name || '',
        isPlatformAdmin,
        roles: userData.roles || [],
        memberships,
        token,
      };

      req.auth = {
        sub: String(userData.id),
        email: userData.email,
        authType: 'one',
        token,
        isPlatformAdmin,
      };

      return next();
    }
  } catch (oneError) {
    // Si One retornó error 503/504 (timeout o indisponibilidad), propagarlo
    if (oneError.statusCode && oneError.statusCode >= 500) {
      return res.status(oneError.statusCode).json({
        message: oneError.message,
        details: oneError.details || undefined,
      });
    }

    // Si One no lo validó o no está disponible, intentar fallback local si existe secret
    if (config.jwtSecret) {
      try {
        const payload = jwt.verify(token, config.jwtSecret);
        req.auth = {
          ...payload,
          authType: 'local',
        };
        return next();
      } catch (localJwtError) {
        // Falló tanto One como el token local
      }
    }

    return res.status(401).json({
      message: 'Token de acceso no válido o expirado.',
      details: oneError.message,
    });
  }
}

module.exports = {
  requireAuth,
};

