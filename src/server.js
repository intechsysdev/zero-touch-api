const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { config } = require('./config');
const { initDatabase, checkDatabaseConnection } = require('./db');
const { login } = require('./auth.service');
const {
  requireAuth,
  resolveTenant,
  generalLimiter,
  authLimiter,
} = require('./middleware');
const { sessionRouter } = require('./session/session.routes');
const { zeroTouchRouter } = require('./zerotouch/zerotouch.routes');
const { samsungRouter } = require('./samsung/samsung.routes');

const app = express();

// Paso 1: Configurar proxy de Azure (XForwardedFor + XForwardedProto)
if (config.trustProxy) {
  app.set('trust proxy', 1);
}

// Paso 2: Encabezados de seguridad con Helmet
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

// Paso 3: CORS temprano para que las respuestas de error también incluyan los headers
app.use(
  cors({
    origin(origin, callback) {
      // Permitir peticiones sin origen (curl, server-to-server) o con origen "null" (vistas locales/móviles)
      if (!origin || origin === 'null') {
        return callback(null, true);
      }

      if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('CORS origin is not allowed.'));
    },
  })
);

// Paso 4: Parsing JSON del cuerpo de las peticiones
app.use(express.json());

// Paso 5: Rate Limiting Global
app.use(generalLimiter);

// ══════════════════════════════════════════════
// RUTAS PÚBLICAS Y DE SALUD
// ══════════════════════════════════════════════

// Health check estándar y equivalente /api/v1/salud del análisis
app.get(['/health', '/api/v1/salud'], (req, res) => {
  res.json({
    ok: true,
    service: 'zero-touch-api',
    appSlug: config.oneAppSlug,
    timestamp: new Date().toISOString(),
  });
});

// Readiness probe con verificación de base de datos
app.get('/ready', async (req, res) => {
  try {
    await checkDatabaseConnection();
    res.json({ ok: true, db: 'up' });
  } catch (error) {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

// ══════════════════════════════════════════════
// AUTENTICACIÓN Y SESIÓN
// ══════════════════════════════════════════════

// Login clásico (MVP legacy) protegido con authLimiter
app.post('/auth/login', authLimiter, async (req, res, next) => {
  try {
    const response = await login(req.body);
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// Endpoint de sesión para la consola SPA (/api/v1/sesion y alias /api/v1/session)
app.use(
  ['/api/v1/sesion', '/api/v1/session'],
  authLimiter,
  requireAuth,
  resolveTenant,
  sessionRouter
);

// ══════════════════════════════════════════════
// RUTAS DE NEGOCIO (Zero Touch y Samsung Knox)
// ══════════════════════════════════════════════
app.use('/zerotouch', requireAuth, resolveTenant, zeroTouchRouter);
app.use('/samsung', requireAuth, resolveTenant, samsungRouter);

// ══════════════════════════════════════════════
// MANEJO GLOBAL DE ERRORES
// ══════════════════════════════════════════════
app.use((error, req, res, next) => {
  if (error.message === 'CORS origin is not allowed.') {
    return res.status(403).json({ message: error.message });
  }

  const status = error.statusCode || 500;
  res.status(status).json({
    message: error.message || 'Internal server error',
    details: error.details || undefined,
  });
});

async function start() {
  await initDatabase();
  app.listen(config.port, () => {
    console.log(`ZeroTouch API running on http://localhost:${config.port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start backend:', error);
    process.exit(1);
  });
}

module.exports = { app, start };
