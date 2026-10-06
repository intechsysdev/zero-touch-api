const crypto = require('crypto');

/**
 * Caché en memoria con tiempo de vida (TTL), emulando IMemoryCache de .NET.
 */
class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, {
      value,
      expiry: Date.now() + ttlMs,
    });
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

const cache = new MemoryCache();

/**
 * Genera el hash SHA-256 en formato hexadecimal.
 * Utilizado para crear claves de caché seguras sin almacenar tokens o secretos en texto plano.
 */
function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

module.exports = {
  cache,
  sha256,
};

