const jwt = require('jsonwebtoken');
const { config } = require('../config');

function requireAuth(req, res, next) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.substring('Bearer '.length)
    : null;

  if (!token) {
    return res.status(401).json({ message: 'Missing bearer token.' });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.auth = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

module.exports = { requireAuth };
