const { GoogleAuth } = require('google-auth-library');
const { config } = require('../config');

const ZERO_TOUCH_SCOPES = [
  'https://www.googleapis.com/auth/androidworkprovisioning',
  'https://www.googleapis.com/auth/androidworkzerotouchemm',
];

function getGoogleAuth() {
  if (config.googleServiceAccountJson.trim()) {
    const credentials = JSON.parse(config.googleServiceAccountJson);
    return new GoogleAuth({
      credentials,
      scopes: ZERO_TOUCH_SCOPES,
    });
  }

  if (config.googleApplicationCredentials.trim()) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = config.googleApplicationCredentials;
  }

  return new GoogleAuth({ scopes: ZERO_TOUCH_SCOPES });
}

const googleAuth = getGoogleAuth();

async function getAccessToken() {
  const client = await googleAuth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token =
    typeof accessTokenResponse === 'string'
      ? accessTokenResponse
      : accessTokenResponse?.token;

  if (!token) {
    throw new Error('No Google access token available for Zero-touch.');
  }

  return token;
}

async function callZeroTouch(path, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(`${config.zeroTouchBaseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    const errorMessage =
      parsed.error?.message ||
      parsed.raw ||
      'Zero-touch API error.';
    const error = new Error(errorMessage);
    error.statusCode = response.status;
    error.details = parsed;
    throw error;
  }

  return parsed;
}

async function listCustomers() {
  return callZeroTouch(`/partners/${config.zeroTouchPartnerId}/customers`);
}

async function findDevicesByOwner({ customerId, pageSize = 20, pageToken = '' }) {
  return callZeroTouch(`/partners/${config.zeroTouchPartnerId}/devices:findByOwner`, {
    method: 'POST',
    body: {
      customerId: [customerId],
      sectionType: 'SECTION_TYPE_ZERO_TOUCH',
      limit: pageSize,
      pageToken,
    },
  });
}

async function listConfigurations({ customerId }) {
  return callZeroTouch(`/customers/${customerId}/configurations`);
}

async function createConfiguration({
  customerId,
  configurationName,
  dpcResourcePath,
  dpcExtras,
  companyName,
}) {
  return callZeroTouch(`/customers/${customerId}/configurations`, {
    method: 'POST',
    body: {
      configurationName,
      dpcResourcePath,
      dpcExtras,
      companyName,
    },
  });
}

async function deleteConfiguration({ customerId, configurationId }) {
  return callZeroTouch(`/customers/${customerId}/configurations/${configurationId}`, {
    method: 'DELETE',
  });
}

async function claimDevice({ customerId, deviceIdentifier, configurationId }) {
  const body = {
    customerId,
    deviceIdentifier,
    sectionType: 'SECTION_TYPE_ZERO_TOUCH',
  };

  if (configurationId !== undefined && configurationId !== null && configurationId !== '') {
    body.configurationId = configurationId;
  }

  return callZeroTouch(`/partners/${config.zeroTouchPartnerId}/devices:claim`, {
    method: 'POST',
    body,
  });
}

async function unclaimDevice({ deviceIdentifier }) {
  return callZeroTouch(`/partners/${config.zeroTouchPartnerId}/devices:unclaim`, {
    method: 'POST',
    body: {
      deviceIdentifier,
      sectionType: 'SECTION_TYPE_ZERO_TOUCH',
    },
  });
}

module.exports = {
  listCustomers,
  listConfigurations,
  createConfiguration,
  deleteConfiguration,
  findDevicesByOwner,
  claimDevice,
  unclaimDevice,
};
