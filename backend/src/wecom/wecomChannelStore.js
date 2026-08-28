const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'wecom-channel.db');
const SHA256_HEX = /^[a-f0-9]{64}$/;

function createWecomChannelStore({ dbPath = DEFAULT_DB_PATH } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS wecom_channel_identities (
      external_subject_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wecom_channel_onboarding (
      user_id TEXT PRIMARY KEY,
      intro_version TEXT,
      intro_sent_at TEXT,
      service_choice TEXT CHECK(service_choice IN ('free', 'subscribed')),
      graph_started_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wecom_account_deletion_requests (
      request_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      request_type TEXT NOT NULL CHECK(request_type IN ('explicit_deletion', 'ambiguous_stop')),
      status TEXT NOT NULL CHECK(status IN ('recorded', 'pending_confirmation')),
      source_message_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wecom_deletion_user_time
      ON wecom_account_deletion_requests(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wecom_callback_messages (
      message_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
      response_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const selectIdentity = db.prepare(
    'SELECT user_id FROM wecom_channel_identities WHERE external_subject_hash = ?'
  );
  const insertIdentity = db.prepare(`
    INSERT INTO wecom_channel_identities
      (external_subject_hash, user_id, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(external_subject_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `);
  const selectOnboarding = db.prepare(
    'SELECT * FROM wecom_channel_onboarding WHERE user_id = ?'
  );
  const recordIntroStmt = db.prepare(`
    INSERT INTO wecom_channel_onboarding
      (user_id, intro_version, intro_sent_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      intro_version = excluded.intro_version,
      intro_sent_at = COALESCE(wecom_channel_onboarding.intro_sent_at, excluded.intro_sent_at),
      updated_at = excluded.updated_at
  `);
  const setChoiceStmt = db.prepare(`
    INSERT INTO wecom_channel_onboarding (user_id, service_choice, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      service_choice = excluded.service_choice,
      updated_at = excluded.updated_at
  `);
  const markGraphStartedStmt = db.prepare(`
    UPDATE wecom_channel_onboarding
    SET graph_started_at = COALESCE(graph_started_at, ?), updated_at = ?
    WHERE user_id = ?
  `);
  const insertDeletionStmt = db.prepare(`
    INSERT INTO wecom_account_deletion_requests
      (request_id, user_id, request_type, status, source_message_hash,
       idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `);
  const listDeletionStmt = db.prepare(`
    SELECT request_id, user_id, request_type, status, source_message_hash,
           idempotency_key, created_at, updated_at
    FROM wecom_account_deletion_requests
    WHERE user_id = ?
    ORDER BY created_at ASC, request_id ASC
  `);
  const selectMessageStmt = db.prepare(
    'SELECT status, response_text FROM wecom_callback_messages WHERE message_key = ?'
  );
  const insertMessageStmt = db.prepare(`
    INSERT INTO wecom_callback_messages
      (message_key, user_id, status, created_at, updated_at)
    VALUES (?, ?, 'processing', ?, ?)
    ON CONFLICT(message_key) DO NOTHING
  `);
  const completeMessageStmt = db.prepare(`
    UPDATE wecom_callback_messages
    SET status = 'completed', response_text = ?, updated_at = ?
    WHERE message_key = ?
  `);
  const failMessageStmt = db.prepare(`
    UPDATE wecom_callback_messages
    SET status = 'failed', updated_at = ?
    WHERE message_key = ?
  `);

  function resolveIdentity(externalSubjectHash, { now = new Date().toISOString() } = {}) {
    const hash = String(externalSubjectHash || '').trim().toLowerCase();
    if (!SHA256_HEX.test(hash)) throw new Error('企业微信身份摘要格式不正确');
    const existing = selectIdentity.get(hash);
    const userId = existing?.user_id || `wecom:${crypto.randomUUID()}`;
    insertIdentity.run(hash, userId, now, now);
    return userId;
  }

  function getOnboarding(userId) {
    const row = selectOnboarding.get(userId);
    if (!row) return null;
    return {
      userId,
      introVersion: row.intro_version,
      introSentAt: row.intro_sent_at,
      serviceChoice: row.service_choice,
      graphStartedAt: row.graph_started_at,
      updatedAt: row.updated_at,
    };
  }

  function recordIntro(userId, introVersion, { now = new Date().toISOString() } = {}) {
    recordIntroStmt.run(userId, introVersion, now, now);
    return getOnboarding(userId);
  }

  function setServiceChoice(userId, serviceChoice, { now = new Date().toISOString() } = {}) {
    if (!['free', 'subscribed'].includes(serviceChoice)) throw new Error('企业微信服务选择不正确');
    setChoiceStmt.run(userId, serviceChoice, now);
    return getOnboarding(userId);
  }

  function getInitialGraphState(userId) {
    const state = getOnboarding(userId);
    if (!state?.serviceChoice || state.graphStartedAt) return null;
    return { serviceTier: state.serviceChoice };
  }

  function markGraphStarted(userId, { now = new Date().toISOString() } = {}) {
    markGraphStartedStmt.run(now, now, userId);
    return getOnboarding(userId);
  }

  function recordDeletionRequest({
    userId,
    requestType,
    sourceMessageHash,
    idempotencyKey,
    now = new Date().toISOString(),
  }) {
    if (!['explicit_deletion', 'ambiguous_stop'].includes(requestType)) {
      throw new Error('注销请求类型不正确');
    }
    if (!SHA256_HEX.test(sourceMessageHash)) throw new Error('注销请求摘要不正确');
    const status = requestType === 'explicit_deletion' ? 'recorded' : 'pending_confirmation';
    insertDeletionStmt.run(
      crypto.randomUUID(), userId, requestType, status, sourceMessageHash,
      idempotencyKey, now, now
    );
    return { status, requestType };
  }

  function listDeletionRequests(userId) {
    return listDeletionStmt.all(userId).map((row) => ({
      requestId: row.request_id,
      userId: row.user_id,
      requestType: row.request_type,
      status: row.status,
      sourceMessageHash: row.source_message_hash,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  function beginMessage(messageKey, userId, { now = new Date().toISOString() } = {}) {
    const existing = selectMessageStmt.get(messageKey);
    if (existing) return { isNew: false, status: existing.status, responseText: existing.response_text };
    insertMessageStmt.run(messageKey, userId, now, now);
    return { isNew: true, status: 'processing', responseText: null };
  }

  function completeMessage(messageKey, responseText, { now = new Date().toISOString() } = {}) {
    completeMessageStmt.run(String(responseText || ''), now, messageKey);
  }

  function failMessage(messageKey, { now = new Date().toISOString() } = {}) {
    failMessageStmt.run(now, messageKey);
  }

  function close() {
    db.close();
  }

  return {
    dbPath,
    resolveIdentity,
    getOnboarding,
    recordIntro,
    setServiceChoice,
    getInitialGraphState,
    markGraphStarted,
    recordDeletionRequest,
    listDeletionRequests,
    beginMessage,
    completeMessage,
    failMessage,
    close,
  };
}

module.exports = { createWecomChannelStore, DEFAULT_DB_PATH };
