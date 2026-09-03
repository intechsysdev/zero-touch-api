#!/usr/bin/env node

const { findDevicesByOwner } = require('../src/zerotouch/zerotouch.client');

async function main() {
  const customerId = process.argv[2];
  const pageSizeRaw = process.argv[3] || '20';
  const pageSize = Number(pageSizeRaw);

  if (!customerId) {
    console.error('Usage: npm run zerotouch:devices -- <customerId> [pageSize]');
    process.exit(1);
  }

  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    console.error('pageSize must be a positive number.');
    process.exit(1);
  }

  const data = await findDevicesByOwner({
    customerId,
    pageSize,
    pageToken: '',
  });

  const devices = Array.isArray(data.devices) ? data.devices : [];

  console.log(`customerId: ${customerId}`);
  console.log(`devicesFound: ${devices.length}`);

  if (!devices.length) {
    console.log('No devices returned for this customer.');
    return;
  }

  for (const item of devices) {
    const identifier = item.deviceIdentifier || {};
    const serial = identifier.serialNumber || item.serialNumber || 'N/A';
    const model = identifier.model || item.model || 'N/A';
    const manufacturer = identifier.manufacturer || 'N/A';
    const imei = identifier.imei || 'N/A';
    console.log(`- serial=${serial} | model=${model} | manufacturer=${manufacturer} | imei=${imei}`);
  }
}

main().catch((error) => {
  console.error('Failed to list devices:', error.message);
  if (error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exit(1);
});
