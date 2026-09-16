const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { config } = require('./config');
const { initDatabase, checkDatabaseConnection } = require('./db');
const { login } = require('./auth.service');
const { requireAuth } = require('./middleware/auth.middleware');
const { zeroTouchRouter } = require('./zerotouch/zerotouch.routes');
const { samsungRouter } = require('./samsung/samsung.routes');

const app = express();

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('CORS origin is not allowed.'));
    },
  })
);

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'backend-intechsys' });
});

app.get('/ready', async (req, res) => {
  try {
    await checkDatabaseConnection();
    res.json({ ok: true, db: 'up' });
  } catch (error) {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.post('/auth/login', async (req, res, next) => {
  try {
    const response = await login(req.body);
    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.use('/zerotouch', requireAuth, zeroTouchRouter);
app.use('/samsung', requireAuth, samsungRouter);

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
    console.log(`Backend Intechsys running on http://localhost:${config.port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start backend:', error);
  process.exit(1);
});
