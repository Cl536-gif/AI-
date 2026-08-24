const {
  UserIdSchema,
  UserEventSchema,
  ConsentSchema,
} = require('../domain/userDataContract');
const {
  withPostgresClient,
  withUserTransaction,
} = require('../db/postgresTransaction');
const { assertUserStore, USER_STORE_METHODS } = require('./userStoreContract');
const {
  DATABASE_READY_METHODS,
  assertCompleteCapabilityInventory,
} = require('./tencentPostgresUserStoreCapabilities');

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ACTIVE_EVENT_STATUS = 'active';
const CONSENT_TYPES = new Set([
  'long_term_profile',
  'menstrual_tracking',
  'proactive_reminders',
]);

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return value == null ? null : String(value);
}

function normalizeRpcResult(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function firstRpcResult(queryResult) {
  return normalizeRpcResult(queryResult?.rows?.[0]?.result ?? null);
}

function mapEventRow(userId, row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    userId,
    eventType: row.event_type,
    occurredAt: normalizeTimestamp(row.occurred_at),
    recordedAt: normalizeTimestamp(row.recorded_at),
    payload: row.payload,
    source: row.source,
    idempotencyKey: row.idempotency_key ?? null,
    supersedesEventId: row.supersedes_event_id ?? null,
    status: row.status || ACTIVE_EVENT_STATUS,
  };
}

function mapRpcEvent(userId, value) {
  if (!value) return null;
  return {
    eventId: value.eventId,
    userId,
    eventType: value.eventType,
    occurredAt: normalizeTimestamp(value.occurredAt),
    recordedAt: normalizeTimestamp(value.recordedAt),
    payload: value.payload,
    source: value.source,
    idempotencyKey: value.idempotencyKey ?? null,
    supersedesEventId: value.supersedesEventId ?? null,
    status: ACTIVE_EVENT_STATUS,
  };
}

function unavailableMethod(methodName) {
  return async function postgresUserStoreMethodUnavailable() {
    const error = new Error(`TencentPostgresUserStore.${methodName} 尚未完成004契约验收`);
    error.code = 'POSTGRES_USER_STORE_METHOD_UNAVAILABLE';
    error.methodName = methodName;
    throw error;
  };
}

function createTencentPostgresUserStore({
  runUserTransaction = withUserTransaction,
  runPostgresClient = withPostgresClient,
} = {}) {
  if (typeof runUserTransaction !== 'function' || typeof runPostgresClient !== 'function') {
    throw new TypeError('创建TencentPostgresUserStore需要有效的PostgreSQL事务执行器');
  }
  assertCompleteCapabilityInventory();

  async function ensureUser(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    await runUserTransaction(normalizedUserId, async (client) => {
      await client.query(
        "INSERT INTO app.users (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING",
        [normalizedUserId]
      );
    });
    return normalizedUserId;
  }

  async function resolveAnonymousIdentity(externalSubjectHash) {
    const normalizedHash = String(externalSubjectHash || '').trim().toLowerCase();
    if (!SHA256_HEX.test(normalizedHash)) {
      throw new Error('匿名身份摘要格式不正确');
    }
    return runPostgresClient(async (client) => {
      const result = await client.query(
        'SELECT app.resolve_anonymous_identity($1, $2) AS result',
        ['device_sha256', normalizedHash]
      );
      return firstRpcResult(result)?.userId || null;
    });
  }

  async function mergeAnonymousIntoAccount(sourceUserId, authenticatedAccountId) {
    const source = UserIdSchema.parse(sourceUserId);
    const accountSubject = UserIdSchema.parse(authenticatedAccountId);
    if (!source.startsWith('anon:')) throw new Error('只能合并匿名游客身份');
    if (accountSubject.startsWith('anon:') || accountSubject.startsWith('acct:')) {
      throw new Error('authenticatedAccountId必须是认证系统提供的原始账号标识');
    }
    const targetUserId = UserIdSchema.parse(`acct:${accountSubject}`);
    return runUserTransaction(targetUserId, async (client) => {
      const result = await client.query(
        'SELECT app.merge_current_account_from_anonymous($1) AS result',
        [source]
      );
      return firstRpcResult(result);
    });
  }

  async function releaseMergedSensitiveEvents(userId, mergeId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedMergeId = String(mergeId || '').trim();
    if (!normalizedMergeId) throw new Error('mergeId不能为空');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.release_current_merged_sensitive_events($1::uuid) AS result',
        [normalizedMergeId]
      );
      return Number(firstRpcResult(result));
    });
  }

  async function appendEvent(input) {
    const parsed = UserEventSchema.parse(input);
    const { userId, ...event } = parsed;
    return runUserTransaction(userId, async (client) => {
      await client.query(
        "INSERT INTO app.users (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING",
        [userId]
      );
      const result = await client.query(
        'SELECT app.append_current_user_event($1::jsonb) AS result',
        [JSON.stringify(event)]
      );
      return mapRpcEvent(userId, firstRpcResult(result));
    });
  }

  async function getEvent(userId, eventId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedEventId = String(eventId || '').trim();
    if (!normalizedEventId) throw new Error('eventId不能为空');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        "SELECT event_id, event_type, occurred_at, recorded_at, payload, source, idempotency_key, supersedes_event_id, status FROM app.user_events WHERE user_id = $1 AND event_id = $2 AND status = 'active' LIMIT 1",
        [normalizedUserId, normalizedEventId]
      );
      return mapEventRow(normalizedUserId, result.rows[0]);
    });
  }

  async function listEvents(userId, { eventType = null, limit = 100 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const normalizedEventType = eventType == null ? null : String(eventType).trim();
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = normalizedEventType
        ? await client.query(
          "SELECT event_id, event_type, occurred_at, recorded_at, payload, source, idempotency_key, supersedes_event_id, status FROM app.user_events WHERE user_id = $1 AND event_type = $2 AND status = 'active' ORDER BY occurred_at DESC, event_id DESC LIMIT $3",
          [normalizedUserId, normalizedEventType, safeLimit]
        )
        : await client.query(
          "SELECT event_id, event_type, occurred_at, recorded_at, payload, source, idempotency_key, supersedes_event_id, status FROM app.user_events WHERE user_id = $1 AND status = 'active' ORDER BY occurred_at DESC, event_id DESC LIMIT $2",
          [normalizedUserId, safeLimit]
        );
      return result.rows.map((row) => mapEventRow(normalizedUserId, row));
    });
  }

  async function recordConsent(input) {
    const parsed = ConsentSchema.parse(input);
    const { userId, ...consent } = parsed;
    return runUserTransaction(userId, async (client) => {
      await client.query(
        "INSERT INTO app.users (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING",
        [userId]
      );
      const result = await client.query(
        'SELECT app.record_current_user_consent($1::jsonb) AS result',
        [JSON.stringify(consent)]
      );
      return firstRpcResult(result);
    });
  }

  async function getLatestConsent(userId, consentType) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedConsentType = String(consentType || '').trim();
    if (!CONSENT_TYPES.has(normalizedConsentType)) throw new Error('授权类型不正确');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT consent_type, status, recorded_at, source FROM app.user_consents WHERE user_id = $1 AND consent_type = $2 ORDER BY created_at DESC, consent_id DESC LIMIT 1',
        [normalizedUserId, normalizedConsentType]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        userId: normalizedUserId,
        consentType: row.consent_type,
        status: row.status,
        recordedAt: normalizeTimestamp(row.recorded_at),
        source: row.source,
      };
    });
  }

  const implementedMethods = {
    ensureUser,
    resolveAnonymousIdentity,
    mergeAnonymousIntoAccount,
    releaseMergedSensitiveEvents,
    appendEvent,
    getEvent,
    listEvents,
    recordConsent,
    getLatestConsent,
  };
  const store = {};
  for (const methodName of USER_STORE_METHODS) {
    store[methodName] = implementedMethods[methodName] || unavailableMethod(methodName);
  }
  store.close = async () => {};

  if (!DATABASE_READY_METHODS.every((methodName) => implementedMethods[methodName])) {
    throw new Error('TencentPostgresUserStore遗漏数据库已就绪方法');
  }
  return assertUserStore(store, { adapterName: 'TencentPostgresUserStore' });
}

module.exports = {
  createTencentPostgresUserStore,
};
