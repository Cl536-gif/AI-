const crypto = require('crypto');
const { getUserStore } = require('../stores/userStoreProvider');

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId.trim())) {
    throw new Error('deviceId格式不正确');
  }
  return deviceId.trim().toLowerCase();
}

function hashDeviceId(deviceId) {
  return crypto.createHash('sha256').update(`diet-secretary-device:v1:${deviceId}`).digest('hex');
}

async function resolveAnonymousUser(deviceId, { store = getUserStore(), now } = {}) {
  const normalizedDeviceId = validateDeviceId(deviceId);
  const externalSubjectHash = hashDeviceId(normalizedDeviceId);
  return await store.resolveAnonymousIdentity(externalSubjectHash, { now });
}

module.exports = {
  DEVICE_ID_PATTERN,
  validateDeviceId,
  hashDeviceId,
  resolveAnonymousUser,
};
