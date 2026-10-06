const rateLimit = require('express-rate-limit');

/**
 * Políticas de Rate Limiting particionadas por IP remota.
 * Conforme a la Sección 8 del documento de arquitectura (analisisfirma.md):
 * 1. general: 300 peticiones / minuto (global)
 * 2. cuenta / auth: 40 peticiones / minuto (login, sesión)
 * 3. devices / operaciones pesadas: 20 peticiones / minuto (claim, bulk, unclaim)
 */

const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Demasiadas peticiones en la API. Por favor intente nuevamente en un minuto.',
  },
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Demasiados intentos de autenticación o validación de cuenta. Reintente en un minuto.',
  },
});

const devicesLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Límite de operaciones de enrolamiento alcanzado. Reintente en un minuto.',
  },
});

module.exports = {
  generalLimiter,
  authLimiter,
  devicesLimiter,
};

