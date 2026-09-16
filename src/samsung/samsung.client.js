const { config } = require('../config');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const knoxTokenLibraryJs = require('knox-token-library-js');

let tokenCache = {
  accessToken: '',
  expiresAtMs: 0,
};

let legacyTokenCache = {
  signedApiToken: '',
  expiresAtMs: 0,
};

let keyMaterialCache = {
  loaded: false,
  keysPath: '',
  publicKey: '',
};

function resolveAuthMode() {
  const mode = String(config.samsungKnoxAuthMode || '').trim().toLowerCase();
  if (mode === 'auto') {
    if (config.samsungKnoxClientId.trim() && config.samsungKnoxClientSecret.trim()) {
      return 'oauth';
    }
    return 'legacy';
  }
  if (mode === 'oauth') {
    return 'oauth';
  }
  return 'legacy';
}

function parseTokenExpiryMs(token, fallbackSeconds = 1200) {
  try {
    const sections = String(token || '').split('.');
    if (sections.length !== 3) {
      return Date.now() + fallbackSeconds * 1000;
    }

    const payload = JSON.parse(
      Buffer.from(sections[1], 'base64url').toString('utf8')
    );
    const exp = Number(payload.exp || 0);
    if (!Number.isFinite(exp) || exp <= 0) {
      return Date.now() + fallbackSeconds * 1000;
    }
    return exp * 1000;
  } catch {
    return Date.now() + fallbackSeconds * 1000;
  }
}

function loadKnoxKeyMaterial() {
  if (keyMaterialCache.loaded) {
    return keyMaterialCache;
  }

  let keysContent = '';
  const explicitKeysPath = String(config.samsungKnoxKeysPath || '').trim();

  if (explicitKeysPath) {
    keysContent = fs.readFileSync(explicitKeysPath, 'utf8');
  } else {
    keysContent = String(config.samsungKnoxKeysJson || '').trim();
  }

  if (!keysContent) {
    const error = new Error(
      'Samsung Knox legacy no configurado: faltan SAMSUNG_KNOX_KEYS_JSON o SAMSUNG_KNOX_KEYS_PATH.'
    );
    error.statusCode = 500;
    throw error;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(keysContent);
  } catch {
    const error = new Error('SAMSUNG_KNOX_KEYS_JSON no contiene JSON valido.');
    error.statusCode = 500;
    throw error;
  }

  const publicKey = String(parsed.Public || parsed.public || '').trim();
  const privateKey = String(parsed.Private || parsed.private || '').trim();
  if (!publicKey || !privateKey) {
    const error = new Error('keys.json invalido: faltan llaves Public/Private.');
    error.statusCode = 500;
    throw error;
  }

  const writePath = path.join(
    os.tmpdir(),
    `knox-keys-${process.pid}-${crypto.randomUUID()}.json`
  );
  fs.writeFileSync(writePath, JSON.stringify(parsed), { mode: 0o600 });

  keyMaterialCache = {
    loaded: true,
    keysPath: writePath,
    publicKey,
  };

  return keyMaterialCache;
}

function isSamsungConfigured() {
  if (!config.samsungKnoxEnabled) {
    return false;
  }

  if (config.samsungKnoxAccessToken.trim()) {
    return true;
  }

  if (resolveAuthMode() === 'legacy') {
    return Boolean(
      config.samsungKnoxClientIdentifier.trim() &&
        (config.samsungKnoxKeysJson.trim() || config.samsungKnoxKeysPath.trim())
    );
  }

  return Boolean(
    config.samsungKnoxClientId.trim() &&
      config.samsungKnoxClientSecret.trim() &&
      config.samsungKnoxApiToken.trim()
  );
}

async function getKnoxAccessToken() {
  if (config.samsungKnoxAccessToken.trim()) {
    return config.samsungKnoxAccessToken.trim();
  }

  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAtMs - now > 60_000) {
    return tokenCache.accessToken;
  }

  if (!config.samsungKnoxClientId.trim() || !config.samsungKnoxClientSecret.trim()) {
    const error = new Error(
      'Samsung Knox no configurado: faltan SAMSUNG_KNOX_CLIENT_ID/SAMSUNG_KNOX_CLIENT_SECRET.'
    );
    error.statusCode = 500;
    throw error;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.samsungKnoxClientId.trim(),
    client_secret: config.samsungKnoxClientSecret.trim(),
  });
  if (String(config.samsungKnoxOAuthScope || '').trim()) {
    body.set('scope', config.samsungKnoxOAuthScope.trim());
  }

  const response = await fetch(config.samsungKnoxOAuthTokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { message: rawText };
  }

  if (!response.ok) {
    const error = new Error(
      payload.message || `Samsung OAuth error: HTTP ${response.status}`
    );
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  const accessToken = String(payload.access_token || '').trim();
  if (!accessToken) {
    const error = new Error('Samsung OAuth no devolvio access_token.');
    error.statusCode = 500;
    error.details = payload;
    throw error;
  }

  const expiresIn = Number(payload.expires_in || 300);
  tokenCache = {
    accessToken,
    expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000,
  };

  return accessToken;
}

async function getLegacySignedApiToken() {
  if (config.samsungKnoxAccessToken.trim()) {
    return config.samsungKnoxAccessToken.trim();
  }

  const now = Date.now();
  if (legacyTokenCache.signedApiToken && legacyTokenCache.expiresAtMs - now > 60_000) {
    return legacyTokenCache.signedApiToken;
  }

  const clientIdentifier = String(config.samsungKnoxClientIdentifier || '').trim();
  if (!clientIdentifier) {
    const error = new Error(
      'Samsung Knox legacy no configurado: falta SAMSUNG_KNOX_CLIENT_IDENTIFIER.'
    );
    error.statusCode = 500;
    throw error;
  }

  const keys = loadKnoxKeyMaterial();
  const signedClientIdentifier = knoxTokenLibraryJs.generateSignedClientIdentifierJWT(
    keys.keysPath,
    clientIdentifier
  );

  const response = await fetch(`${config.samsungKnoxBaseUrl}/users/accesstoken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      clientIdentifierJwt: signedClientIdentifier,
      base64EncodedStringPublicKey: keys.publicKey,
      validityForAccessTokenInMinutes: 30,
    }),
  });

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { message: rawText };
  }

  if (!response.ok) {
    const error = new Error(
      payload.message || `Samsung access token error: HTTP ${response.status}`
    );
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  const accessToken = String(payload.accessToken || payload.access_token || '').trim();
  if (!accessToken) {
    const error = new Error('Samsung accesstoken API no devolvio accessToken.');
    error.statusCode = 500;
    error.details = payload;
    throw error;
  }

  const signedAccessToken = knoxTokenLibraryJs.generateSignedAccessTokenJWT(
    keys.keysPath,
    accessToken
  );

  const expiresAtMs = parseTokenExpiryMs(signedAccessToken, 25 * 60);
  legacyTokenCache = {
    signedApiToken: signedAccessToken,
    expiresAtMs,
  };

  return signedAccessToken;
}

async function callKnox(path, { method = 'GET', query, body, tenantId } = {}) {
  if (!isSamsungConfigured()) {
    const error = new Error('Samsung Knox no esta habilitado en este backend.');
    error.statusCode = 503;
    throw error;
  }

  const url = new URL(`${config.samsungKnoxBaseUrl}${path}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const authMode = resolveAuthMode();
  const managedTenantId = String(tenantId || query?.customerId || '').trim();
  let headers = {
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };

  if (authMode === 'legacy') {
    const signedApiToken = await getLegacySignedApiToken();
    headers = {
      ...headers,
      'x-knox-apitoken': signedApiToken,
      ...(managedTenantId ? { 'x-wsm-managed-tenantid': managedTenantId } : {}),
    };
  } else {
    const accessToken = await getKnoxAccessToken();
    headers = {
      ...headers,
      Authorization: `Bearer ${accessToken}`,
    };
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { message: rawText };
  }

  if (!response.ok) {
    const error = new Error(payload.message || `Samsung Knox error: HTTP ${response.status}`);
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return payload;
}

function normalizeKnoxDevices(payload) {
  const rawDevices =
    payload.deviceList || payload.devices || payload.content || payload.items || payload.results || [];

  if (!Array.isArray(rawDevices)) {
    return [];
  }

  return rawDevices.map((item, index) => {
    const imei = String(item.meidImei || item.imei || item.deviceId || '').trim();
    const serialNumber = String(item.serialNumber || item.sn || imei || '').trim();
    const model = String(item.model || item.modelName || 'Samsung Device').trim();
    const manufacturer = String(item.manufacturer || item.oem || 'Samsung').trim();
    const ownerCompanyId = String(item.customerId || item.ownerCompanyId || '').trim();

    return {
      name: item.name || `samsung/${imei || serialNumber || index}`,
      deviceId: item.deviceId || imei || serialNumber || `samsung-${index}`,
      serialNumber: serialNumber || undefined,
      model,
      manufacturer,
      deviceIdentifier: {
        imei: imei || undefined,
        serialNumber: serialNumber || undefined,
        manufacturer,
        model,
      },
      claims: [
        {
          ownerCompanyId: ownerCompanyId || undefined,
          createTime: item.createdAt || item.createTime || new Date().toISOString(),
        },
      ],
      rawSamsungPayload: item,
    };
  });
}

async function listSamsungDevices({ customerId }) {
  const payload = await callKnox('/kcs/v1/kme/devices/list', {
    method: 'GET',
    tenantId: customerId,
  });

  return {
    customerId,
    devices: normalizeKnoxDevices(payload),
    raw: payload,
  };
}

async function uploadSamsungDevices({ customerId, profileId, devices }) {
  const payload = await callKnox('/kcs/v1/reseller/devices/uploads', {
    method: 'POST',
    body: {
      customerId,
      devices,
      profileId,
    },
  });

  return payload;
}

async function deleteSamsungDevices({ customerId, deviceIds }) {
  return callKnox('/kcs/v1/kme/devices/delete', {
    method: 'POST',
    tenantId: customerId,
    body: {
      customerId,
      devices: {
        deviceIds,
        imeiOrSerials: deviceIds,
      },
    },
  });
}

async function detectSamsungCustomerById(customerId) {
  if (!isSamsungConfigured()) {
    return null;
  }

  try {
    await callKnox('/kcs/v1/kme/devices/list', {
      method: 'GET',
      tenantId: customerId,
    });
    return String(customerId).trim();
  } catch (error) {
    if ([400, 401, 403, 404].includes(error.statusCode)) {
      return null;
    }
    throw error;
  }
}

module.exports = {
  isSamsungConfigured,
  listSamsungDevices,
  uploadSamsungDevices,
  deleteSamsungDevices,
  detectSamsungCustomerById,
};
