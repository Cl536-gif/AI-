const { getUserStore } = require('../stores/userStoreProvider');
const { UserIdSchema } = require('../domain/userDataContract');

const SENSITIVE_EVENT_CONSENTS = {
  menstrual_period_start: 'menstrual_tracking',
  menstrual_symptom: 'menstrual_tracking',
};
const MAX_EVENT_PAYLOAD_BYTES = 50 * 1024;

async function assertSensitiveConsent(userId, eventType, store) {
  const consentType = SENSITIVE_EVENT_CONSENTS[eventType];
  if (!consentType) return;
  const consent = await store.getLatestConsent(userId, consentType);
  if (!consent || consent.status !== 'granted') {
    throw new Error(`缺少当前有效的${consentType}单独授权，不能写入敏感事件`);
  }
}

async function assertCorrectionTarget(userId, command, store) {
  if (command.eventType === 'user_correction' && !command.supersedesEventId) {
    throw new Error('用户纠错事件必须指向被纠正的旧事件');
  }
  if (!command.supersedesEventId) return;
  const target = await store.getEvent(userId, command.supersedesEventId);
  if (!target) throw new Error('被纠正的事件不存在或不属于当前用户');
}

function assertPayloadSize(payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload || {}), 'utf8');
  if (bytes > MAX_EVENT_PAYLOAD_BYTES) throw new Error('事件内容过大');
}

async function recordUserEvent(userId, command, { store = getUserStore(), recordedAt } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('事件命令格式不正确');
  }
  if (Object.prototype.hasOwnProperty.call(command, 'userId')) {
    throw new Error('事件命令不能自行指定userId');
  }

  await assertSensitiveConsent(normalizedUserId, command.eventType, store);
  await assertCorrectionTarget(normalizedUserId, command, store);
  assertPayloadSize(command.payload);

  return await store.appendEvent({
    ...command,
    userId: normalizedUserId,
    recordedAt: recordedAt || command.recordedAt,
  });
}

async function recordUserConsent(userId, consent, { store = getUserStore() } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) {
    throw new Error('授权命令格式不正确');
  }
  if (Object.prototype.hasOwnProperty.call(consent, 'userId')) {
    throw new Error('授权命令不能自行指定userId');
  }
  return await store.recordConsent({ ...consent, userId: normalizedUserId });
}

module.exports = {
  SENSITIVE_EVENT_CONSENTS,
  MAX_EVENT_PAYLOAD_BYTES,
  assertSensitiveConsent,
  recordUserEvent,
  recordUserConsent,
};
