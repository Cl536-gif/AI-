const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  UserIdSchema,
  UserEventSchema,
  ConsentSchema,
  createEmptyUserProfile,
  deepMergeProfile,
} = require('../domain/userDataContract');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function createUserStore({ dbPath = DB_PATH } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      last_active_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      profile_version INTEGER NOT NULL,
      profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_revisions (
      revision_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      profile_version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      changed_fields_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, profile_version)
    );

    CREATE TABLE IF NOT EXISTS user_events (
      event_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT NOT NULL,
      idempotency_key TEXT,
      supersedes_event_id TEXT REFERENCES user_events(event_id),
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(user_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_user_events_user_time
      ON user_events(user_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_events_user_type_time
      ON user_events(user_id, event_type, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS user_consents (
      consent_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      consent_type TEXT NOT NULL,
      status TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      source TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_consents_latest
      ON user_consents(user_id, consent_type, recorded_at DESC);
  `);

  // 兼容仓库里已经存在的旧 users 表，只增列，不破坏现有 user_id/last_active_at。
  ensureColumn(db, 'users', 'created_at', 'TEXT');
  ensureColumn(db, 'users', 'timezone', 'TEXT');
  ensureColumn(db, 'users', 'locale', 'TEXT');
  db.exec('UPDATE users SET created_at = last_active_at WHERE created_at IS NULL');

  const selectActivityStmt = db.prepare('SELECT last_active_at FROM users WHERE user_id = ?');
  const insertUserStmt = db.prepare(`
    INSERT OR IGNORE INTO users (user_id, last_active_at, created_at, timezone, locale)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateActivityStmt = db.prepare('UPDATE users SET last_active_at = ? WHERE user_id = ?');
  const selectProfileStmt = db.prepare(`
    SELECT profile_version, profile_json, created_at, updated_at
    FROM user_profiles WHERE user_id = ?
  `);
  const upsertProfileStmt = db.prepare(`
    INSERT INTO user_profiles (user_id, profile_version, profile_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      profile_version = excluded.profile_version,
      profile_json = excluded.profile_json,
      updated_at = excluded.updated_at
  `);
  const insertRevisionStmt = db.prepare(`
    INSERT INTO profile_revisions
      (revision_id, user_id, profile_version, snapshot_json, changed_fields_json, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRevisionsStmt = db.prepare(`
    SELECT revision_id, profile_version, snapshot_json, changed_fields_json, source, created_at
    FROM profile_revisions
    WHERE user_id = ?
    ORDER BY profile_version DESC
    LIMIT ?
  `);
  const insertEventStmt = db.prepare(`
    INSERT INTO user_events
      (event_id, user_id, event_type, occurred_at, recorded_at, payload_json, source,
       idempotency_key, supersedes_event_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);
  const selectEventByIdempotencyStmt = db.prepare(`
    SELECT event_id, event_type, occurred_at, recorded_at, payload_json, source,
           idempotency_key, supersedes_event_id, status
    FROM user_events WHERE user_id = ? AND idempotency_key = ?
  `);
  const insertConsentStmt = db.prepare(`
    INSERT INTO user_consents
      (consent_id, user_id, consent_type, status, recorded_at, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectLatestConsentStmt = db.prepare(`
    SELECT consent_type, status, recorded_at, source
    FROM user_consents
    WHERE user_id = ? AND consent_type = ?
    ORDER BY recorded_at DESC LIMIT 1
  `);

  function ensureUser(userId, { now = new Date().toISOString(), timezone = 'Asia/Shanghai', locale = 'zh-CN' } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    insertUserStmt.run(normalizedUserId, now, now, timezone, locale);
    return normalizedUserId;
  }

  function recordActivity(userId) {
    const now = new Date().toISOString();
    const normalizedUserId = UserIdSchema.parse(userId);
    const existing = selectActivityStmt.get(normalizedUserId);
    ensureUser(normalizedUserId, { now });
    updateActivityStmt.run(now, normalizedUserId);
    return { previousActiveAt: existing ? existing.last_active_at : null, now };
  }

  function getProfile(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const row = selectProfileStmt.get(normalizedUserId);
    if (!row) return null;
    return {
      userId: normalizedUserId,
      profileVersion: row.profile_version,
      profile: JSON.parse(row.profile_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function updateProfile(userId, patch, { source = 'user', now = new Date().toISOString(), expectedVersion = null } = {}) {
    const normalizedUserId = ensureUser(userId, { now });
    const current = getProfile(normalizedUserId);
    if (expectedVersion !== null && (current?.profileVersion || 0) !== expectedVersion) {
      throw new Error('用户档案版本冲突，请读取最新版本后重试');
    }
    const nextProfile = deepMergeProfile(current?.profile || createEmptyUserProfile(), patch);
    const nextVersion = (current?.profileVersion || 0) + 1;
    const createdAt = current?.createdAt || now;
    const changedFields = Object.keys(patch);

    db.exec('BEGIN IMMEDIATE');
    try {
      upsertProfileStmt.run(
        normalizedUserId,
        nextVersion,
        JSON.stringify(nextProfile),
        createdAt,
        now
      );
      insertRevisionStmt.run(
        crypto.randomUUID(),
        normalizedUserId,
        nextVersion,
        JSON.stringify(nextProfile),
        JSON.stringify(changedFields),
        source,
        now
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return getProfile(normalizedUserId);
  }

  function listProfileRevisions(userId, { limit = 50 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return selectRevisionsStmt.all(normalizedUserId, safeLimit).map((row) => ({
      revisionId: row.revision_id,
      userId: normalizedUserId,
      profileVersion: row.profile_version,
      snapshot: JSON.parse(row.snapshot_json),
      changedFields: JSON.parse(row.changed_fields_json),
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  function appendEvent(input) {
    const parsed = UserEventSchema.parse(input);
    ensureUser(parsed.userId, { now: parsed.recordedAt || new Date().toISOString() });
    if (parsed.idempotencyKey) {
      const existing = selectEventByIdempotencyStmt.get(parsed.userId, parsed.idempotencyKey);
      if (existing) return mapEventRow(parsed.userId, existing);
    }
    const eventId = parsed.eventId || crypto.randomUUID();
    const recordedAt = parsed.recordedAt || new Date().toISOString();
    insertEventStmt.run(
      eventId,
      parsed.userId,
      parsed.eventType,
      parsed.occurredAt,
      recordedAt,
      JSON.stringify(parsed.payload),
      parsed.source,
      parsed.idempotencyKey || null,
      parsed.supersedesEventId || null
    );
    return getEvent(parsed.userId, eventId);
  }

  function mapEventRow(userId, row) {
    if (!row) return null;
    return {
      eventId: row.event_id,
      userId,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      payload: JSON.parse(row.payload_json),
      source: row.source,
      idempotencyKey: row.idempotency_key,
      supersedesEventId: row.supersedes_event_id,
      status: row.status,
    };
  }

  function getEvent(userId, eventId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const row = db.prepare(`
      SELECT event_id, event_type, occurred_at, recorded_at, payload_json, source,
             idempotency_key, supersedes_event_id, status
      FROM user_events WHERE user_id = ? AND event_id = ?
    `).get(normalizedUserId, eventId);
    return mapEventRow(normalizedUserId, row);
  }

  function listEvents(userId, { eventType = null, limit = 100 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows = eventType
      ? db.prepare(`
          SELECT event_id, event_type, occurred_at, recorded_at, payload_json, source,
                 idempotency_key, supersedes_event_id, status
          FROM user_events WHERE user_id = ? AND event_type = ?
          ORDER BY occurred_at DESC LIMIT ?
        `).all(normalizedUserId, eventType, safeLimit)
      : db.prepare(`
          SELECT event_id, event_type, occurred_at, recorded_at, payload_json, source,
                 idempotency_key, supersedes_event_id, status
          FROM user_events WHERE user_id = ?
          ORDER BY occurred_at DESC LIMIT ?
        `).all(normalizedUserId, safeLimit);
    return rows.map((row) => mapEventRow(normalizedUserId, row));
  }

  function recordConsent(input) {
    const parsed = ConsentSchema.parse(input);
    ensureUser(parsed.userId, { now: parsed.recordedAt });
    insertConsentStmt.run(
      crypto.randomUUID(),
      parsed.userId,
      parsed.consentType,
      parsed.status,
      parsed.recordedAt,
      parsed.source
    );
    return getLatestConsent(parsed.userId, parsed.consentType);
  }

  function getLatestConsent(userId, consentType) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const row = selectLatestConsentStmt.get(normalizedUserId, consentType);
    if (!row) return null;
    return {
      userId: normalizedUserId,
      consentType: row.consent_type,
      status: row.status,
      recordedAt: row.recorded_at,
      source: row.source,
    };
  }

  function close() {
    db.close();
  }

  return {
    dbPath,
    ensureUser,
    recordActivity,
    getProfile,
    updateProfile,
    listProfileRevisions,
    appendEvent,
    getEvent,
    listEvents,
    recordConsent,
    getLatestConsent,
    close,
  };
}

const defaultStore = createUserStore();

module.exports = {
  ...defaultStore,
  createUserStore,
  DB_PATH,
};
