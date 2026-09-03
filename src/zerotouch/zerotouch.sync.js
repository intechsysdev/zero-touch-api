const { findDevicesByOwner } = require('./zerotouch.client');
const { replaceClientDevices } = require('../db');

async function syncClientDevices({ clientDbId, customerId, pageSize = 100 }) {
  const allDevices = [];
  let pageToken = '';
  let guard = 0;

  do {
    const data = await findDevicesByOwner({
      customerId,
      pageSize,
      pageToken,
    });

    const devices = Array.isArray(data.devices) ? data.devices : [];
    allDevices.push(...devices);

    pageToken = data.nextPageToken || '';
    guard += 1;
  } while (pageToken && guard < 50);

  await replaceClientDevices(clientDbId, allDevices);

  return {
    syncedCount: allDevices.length,
  };
}

module.exports = {
  syncClientDevices,
};
