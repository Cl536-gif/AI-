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
const SENSITIVE_EVENT_TYPES = new Set(['menstrual_period_start', 'menstrual_symptom']);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function isBlankProfileValue(value) {
  return value === null || value === undefined || value === '' || value === 'unknown' ||
    (Array.isArray(value) && value.length === 0);
}

function profileValuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeProfileAccountFirst(accountProfile, guestProfile) {
  const merged = structuredClone(accountProfile);
  const conflicts = [];
  let changed = false;

  function visit(target, source, pathParts) {
    Object.entries(source || {}).forEach(([key, guestValue]) => {
      if (key === 'schemaVersion' || pathParts[0] === 'menstrualTracking' || key === 'menstrualTracking') return;
      const path = [...pathParts, key];
      const accountValue = target[key];
      if (guestValue && typeof guestValue === 'object' && !Array.isArray(guestValue)) {
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
        visit(target[key], guestValue, path);
      } else if (isBlankProfileValue(accountValue) && !isBlankProfileValue(guestValue)) {
        target[key] = guestValue;
        changed = true;
      } else if (!isBlankProfileValue(accountValue) && !isBlankProfileValue(guestValue) &&
        !profileValuesEqual(accountValue, guestValue)) {
        conflicts.push({ fieldPath: path.join('.'), accountValue, guestValue });
      }
    });
  }

  visit(merged, guestProfile, []);
  return { merged, conflicts, changed };
}

function eventFingerprint(row) {
  return crypto.createHash('sha256').update(JSON.stringify({
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json),
  })).digest('hex');
}

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

    CREATE TABLE IF NOT EXISTS user_advice_history (
      advice_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      advice_type TEXT NOT NULL,
      service_mode TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      thread_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_user_advice_user_time
      ON user_advice_history(user_id, created_at DESC);

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

    CREATE TABLE IF NOT EXISTS user_identities (
      identity_type TEXT NOT NULL,
      external_subject_hash TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (identity_type, external_subject_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_user_identities_user
      ON user_identities(user_id);

    CREATE TABLE IF NOT EXISTS user_service_status (
      user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      trial_started_at TEXT,
      trial_ends_at TEXT,
      renewal_reminder_at TEXT,
      official_plan_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_service_transitions (
      transition_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_service_transitions_user_time
      ON user_service_transitions(user_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS user_notifications (
      notification_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      UNIQUE(user_id, dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS idx_user_notifications_pending
      ON user_notifications(status, scheduled_at);

    CREATE TABLE IF NOT EXISTS user_merges (
      merge_id TEXT PRIMARY KEY,
      source_user_id TEXT NOT NULL UNIQUE REFERENCES users(user_id),
      target_user_id TEXT NOT NULL REFERENCES users(user_id),
      status TEXT NOT NULL,
      merged_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_merge_conflicts (
      conflict_id TEXT PRIMARY KEY,
      merge_id TEXT NOT NULL REFERENCES user_merges(merge_id) ON DELETE CASCADE,
      field_path TEXT NOT NULL,
      account_value_json TEXT NOT NULL,
      guest_value_json TEXT NOT NULL,
      account_updated_at TEXT,
      guest_updated_at TEXT,
      account_stale_over_30_days INTEGER NOT NULL DEFAULT 0,
      resolution_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_merge_audit (
      audit_id TEXT PRIMARY KEY,
      merge_id TEXT NOT NULL REFERENCES user_merges(merge_id) ON DELETE CASCADE,
      source_event_id TEXT NOT NULL,
      target_event_id TEXT,
      action TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS energy_calculations (
      calculation_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      formula_id TEXT NOT NULL,
      formula_version TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      assumptions_json TEXT NOT NULL,
      outputs_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_energy_calculations_user_time
      ON energy_calculations(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_plan_versions (
      plan_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      plan_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      calculation_id TEXT REFERENCES energy_calculations(calculation_id),
      parent_plan_id TEXT REFERENCES user_plan_versions(plan_id),
      plan_json TEXT NOT NULL,
      change_reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      paused_at TEXT,
      completed_at TEXT,
      UNIQUE(user_id, plan_version)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_plan_per_user
      ON user_plan_versions(user_id) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS plan_state_transitions (
      transition_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES user_plan_versions(plan_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_plan_transitions_plan_time
      ON plan_state_transitions(plan_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS plan_revision_commands (
      command_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES user_plan_versions(plan_id),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_plan_revision_commands_user
      ON plan_revision_commands(user_id, updated_at DESC);
  `);

  // 兼容仓库里已经存在的旧 users 表，只增列，不破坏现有 user_id/last_active_at。
  ensureColumn(db, 'users', 'created_at', 'TEXT');
  ensureColumn(db, 'users', 'timezone', 'TEXT');
  ensureColumn(db, 'users', 'locale', 'TEXT');
  ensureColumn(db, 'users', 'account_status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'users', 'merged_into_user_id', 'TEXT');
  db.exec('UPDATE users SET created_at = last_active_at WHERE created_at IS NULL');

  const selectActivityStmt = db.prepare('SELECT last_active_at FROM users WHERE user_id = ?');
  const insertUserStmt = db.prepare(`
    INSERT OR IGNORE INTO users (user_id, last_active_at, created_at, timezone, locale)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateActivityStmt = db.prepare('UPDATE users SET last_active_at = ? WHERE user_id = ?');
  const selectUserSettingsStmt = db.prepare(`
    SELECT timezone, locale, last_active_at, created_at FROM users WHERE user_id = ?
  `);
  const updateUserTimezoneStmt = db.prepare(`UPDATE users SET timezone = ? WHERE user_id = ?`);
  const selectUserStatusStmt = db.prepare('SELECT account_status, merged_into_user_id FROM users WHERE user_id = ?');
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
  const insertAdviceStmt = db.prepare(`
    INSERT OR IGNORE INTO user_advice_history
      (advice_id, user_id, advice_type, service_mode, content, metadata_json,
       thread_id, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectAdviceByIdempotencyStmt = db.prepare(`
    SELECT advice_id, advice_type, service_mode, content, metadata_json,
           thread_id, idempotency_key, created_at
    FROM user_advice_history WHERE user_id = ? AND idempotency_key = ?
  `);
  const selectAdviceHistoryStmt = db.prepare(`
    SELECT advice_id, advice_type, service_mode, content, metadata_json,
           thread_id, idempotency_key, created_at
    FROM user_advice_history WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
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
  const selectIdentityStmt = db.prepare(`
    SELECT user_id FROM user_identities
    WHERE identity_type = ? AND external_subject_hash = ?
  `);
  const insertIdentityStmt = db.prepare(`
    INSERT OR IGNORE INTO user_identities
      (identity_type, external_subject_hash, user_id, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateIdentityLastSeenStmt = db.prepare(`
    UPDATE user_identities SET last_seen_at = ?
    WHERE identity_type = ? AND external_subject_hash = ?
  `);
  const selectServiceStatusStmt = db.prepare(`
    SELECT status, trial_started_at, trial_ends_at, renewal_reminder_at,
           official_plan_id, updated_at
    FROM user_service_status WHERE user_id = ?
  `);
  const upsertServiceStatusStmt = db.prepare(`
    INSERT INTO user_service_status
      (user_id, status, trial_started_at, trial_ends_at, renewal_reminder_at,
       official_plan_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      status = excluded.status,
      trial_started_at = excluded.trial_started_at,
      trial_ends_at = excluded.trial_ends_at,
      renewal_reminder_at = excluded.renewal_reminder_at,
      official_plan_id = excluded.official_plan_id,
      updated_at = excluded.updated_at
  `);
  const insertServiceTransitionStmt = db.prepare(`
    INSERT INTO user_service_transitions
      (transition_id, user_id, from_status, to_status, reason, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectServiceTransitionsStmt = db.prepare(`
    SELECT transition_id, from_status, to_status, reason, occurred_at
    FROM user_service_transitions
    WHERE user_id = ?
    ORDER BY occurred_at DESC
    LIMIT ?
  `);
  const selectDueRenewalUsersStmt = db.prepare(`
    SELECT user_id, trial_started_at, trial_ends_at, renewal_reminder_at
    FROM user_service_status
    WHERE status = 'trial_active'
      AND renewal_reminder_at IS NOT NULL
      AND renewal_reminder_at <= ?
      AND trial_ends_at > ?
    ORDER BY renewal_reminder_at ASC
    LIMIT ?
  `);
  const insertNotificationStmt = db.prepare(`
    INSERT OR IGNORE INTO user_notifications
      (notification_id, user_id, notification_type, dedupe_key, scheduled_at,
       status, attempts, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL)
  `);
  const selectNotificationByDedupeStmt = db.prepare(`
    SELECT notification_id, user_id, notification_type, dedupe_key,
           scheduled_at, status, attempts, created_at, sent_at
    FROM user_notifications
    WHERE user_id = ? AND dedupe_key = ?
  `);
  const selectPendingNotificationsStmt = db.prepare(`
    SELECT notification_id, user_id, notification_type, dedupe_key,
           scheduled_at, status, attempts, created_at, sent_at
    FROM user_notifications
    WHERE status = 'pending' AND scheduled_at <= ?
    ORDER BY scheduled_at ASC
    LIMIT ?
  `);
  const markNotificationSentStmt = db.prepare(`
    UPDATE user_notifications
    SET status = 'sent', sent_at = ?, attempts = attempts + 1
    WHERE notification_id = ? AND status = 'pending'
  `);
  const selectUserMergeStmt = db.prepare(`
    SELECT merge_id, source_user_id, target_user_id, status, merged_at
    FROM user_merges WHERE source_user_id = ?
  `);
  const selectUserMergeByIdStmt = db.prepare(`
    SELECT merge_id, source_user_id, target_user_id, status, merged_at
    FROM user_merges WHERE merge_id = ?
  `);
  const selectProfileConflictsStmt = db.prepare(`
    SELECT conflict_id, field_path, account_value_json, guest_value_json,
           account_updated_at, guest_updated_at, account_stale_over_30_days,
           resolution_status, created_at
    FROM profile_merge_conflicts WHERE merge_id = ? ORDER BY field_path
  `);
  const selectEventMergeAuditStmt = db.prepare(`
    SELECT source_event_id, target_event_id, action, event_hash, created_at
    FROM event_merge_audit WHERE merge_id = ? ORDER BY created_at, source_event_id
  `);
  const insertEnergyCalculationStmt = db.prepare(`
    INSERT INTO energy_calculations
      (calculation_id, user_id, formula_id, formula_version, inputs_json,
       assumptions_json, outputs_json, source_refs_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectEnergyCalculationsStmt = db.prepare(`
    SELECT calculation_id, formula_id, formula_version, inputs_json,
           assumptions_json, outputs_json, source_refs_json, created_at
    FROM energy_calculations WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `);
  const selectPlanStmt = db.prepare(`
    SELECT plan_id, plan_version, status, calculation_id, parent_plan_id,
           plan_json, change_reason, created_at, activated_at, paused_at, completed_at
    FROM user_plan_versions WHERE user_id = ? AND plan_id = ?
  `);
  const selectActivePlanStmt = db.prepare(`
    SELECT plan_id, plan_version, status, calculation_id, parent_plan_id,
           plan_json, change_reason, created_at, activated_at, paused_at, completed_at
    FROM user_plan_versions WHERE user_id = ? AND status = 'active' LIMIT 1
  `);
  const selectPlansStmt = db.prepare(`
    SELECT plan_id, plan_version, status, calculation_id, parent_plan_id,
           plan_json, change_reason, created_at, activated_at, paused_at, completed_at
    FROM user_plan_versions WHERE user_id = ? ORDER BY plan_version DESC LIMIT ?
  `);
  const selectPlanTransitionsStmt = db.prepare(`
    SELECT transition_id, from_status, to_status, reason, occurred_at
    FROM plan_state_transitions WHERE user_id = ? AND plan_id = ?
    ORDER BY occurred_at DESC
  `);
  const selectPlanRevisionCommandStmt = db.prepare(`
    SELECT command_id, plan_id, status, created_at, updated_at
    FROM plan_revision_commands WHERE user_id = ? AND command_id = ?
  `);
  const upsertPlanRevisionCommandStmt = db.prepare(`
    INSERT INTO plan_revision_commands
      (command_id, user_id, plan_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(command_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      status = excluded.status,
      updated_at = excluded.updated_at
    WHERE plan_revision_commands.user_id = excluded.user_id
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

  function getUserSettings(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const row = selectUserSettingsStmt.get(normalizedUserId);
    if (!row) return null;
    return {
      userId: normalizedUserId,
      timezone: row.timezone || 'Asia/Shanghai',
      locale: row.locale || 'zh-CN',
      lastActiveAt: row.last_active_at,
      createdAt: row.created_at,
    };
  }

  function updateUserTimezone(userId, timezone, { now = new Date().toISOString() } = {}) {
    const normalizedUserId = ensureUser(userId, { now });
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(new Date(now));
    } catch (_err) {
      throw new Error('用户时区格式不正确');
    }
    updateUserTimezoneStmt.run(timezone, normalizedUserId);
    return getUserSettings(normalizedUserId);
  }

  function assertUserWritable(userId) {
    const row = selectUserStatusStmt.get(userId);
    if (row?.account_status === 'merged') {
      throw new Error(`匿名身份已合并，请改用正式账号身份${row.merged_into_user_id}`);
    }
  }

  function resolveAnonymousIdentity(externalSubjectHash, { now = new Date().toISOString() } = {}) {
    if (!/^[a-f0-9]{64}$/.test(externalSubjectHash)) {
      throw new Error('匿名身份摘要格式不正确');
    }

    const existing = selectIdentityStmt.get('device', externalSubjectHash);
    if (existing) {
      updateIdentityLastSeenStmt.run(now, 'device', externalSubjectHash);
      ensureUser(existing.user_id, { now });
      return existing.user_id;
    }

    const anonymousUserId = `anon:${crypto.randomUUID()}`;
    ensureUser(anonymousUserId, { now });
    insertIdentityStmt.run('device', externalSubjectHash, anonymousUserId, now, now);
    const resolved = selectIdentityStmt.get('device', externalSubjectHash);
    return resolved.user_id;
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

  function getServiceStatus(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const row = selectServiceStatusStmt.get(normalizedUserId);
    if (!row) return null;
    return {
      userId: normalizedUserId,
      status: row.status,
      trialStartedAt: row.trial_started_at,
      trialEndsAt: row.trial_ends_at,
      renewalReminderAt: row.renewal_reminder_at,
      officialPlanId: row.official_plan_id,
      updatedAt: row.updated_at,
    };
  }

  function setServiceStatus(userId, next, { reason, now = new Date().toISOString() } = {}) {
    const normalizedUserId = ensureUser(userId, { now });
    assertUserWritable(normalizedUserId);
    const current = getServiceStatus(normalizedUserId);
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertServiceStatusStmt.run(
        normalizedUserId,
        next.status,
        next.trialStartedAt || null,
        next.trialEndsAt || null,
        next.renewalReminderAt || null,
        next.officialPlanId || null,
        now
      );
      insertServiceTransitionStmt.run(
        crypto.randomUUID(),
        normalizedUserId,
        current?.status || null,
        next.status,
        reason || 'unspecified',
        now
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return getServiceStatus(normalizedUserId);
  }

  function listServiceTransitions(userId, { limit = 50 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return selectServiceTransitionsStmt.all(normalizedUserId, safeLimit).map((row) => ({
      transitionId: row.transition_id,
      userId: normalizedUserId,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      occurredAt: row.occurred_at,
    }));
  }

  function mapMerge(row) {
    if (!row) return null;
    return {
      mergeId: row.merge_id,
      sourceUserId: row.source_user_id,
      targetUserId: row.target_user_id,
      status: row.status,
      mergedAt: row.merged_at,
    };
  }

  function getUserMerge(userId, sourceUserId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const merge = mapMerge(selectUserMergeStmt.get(UserIdSchema.parse(sourceUserId)));
    return merge?.targetUserId === normalizedUserId ? merge : null;
  }

  function mergeAnonymousIntoAccount(sourceUserId, authenticatedAccountId, {
    now = new Date().toISOString(),
  } = {}) {
    const source = UserIdSchema.parse(sourceUserId);
    const accountSubject = UserIdSchema.parse(authenticatedAccountId);
    if (!source.startsWith('anon:')) throw new Error('只能合并匿名游客身份');
    if (accountSubject.startsWith('anon:') || accountSubject.startsWith('acct:')) {
      throw new Error('authenticatedAccountId必须是认证系统提供的原始账号标识');
    }
    const target = UserIdSchema.parse(`acct:${accountSubject}`);
    const previous = getUserMerge(target, source);
    if (previous) {
      if (previous.targetUserId !== target) throw new Error('该游客身份已经合并到其他账号');
      return previous;
    }

    ensureUser(source, { now });
    ensureUser(target, { now });
    const sourceProfile = getProfile(source);
    const targetProfile = getProfile(target);
    const accountProfile = targetProfile?.profile || createEmptyUserProfile();
    const guestProfile = sourceProfile?.profile || createEmptyUserProfile();
    const profileMerge = mergeProfileAccountFirst(accountProfile, guestProfile);
    const mergeId = crypto.randomUUID();
    const nowMs = new Date(now).getTime();
    const accountUpdatedMs = targetProfile ? new Date(targetProfile.updatedAt).getTime() : nowMs;
    const accountStale = Boolean(targetProfile && nowMs - accountUpdatedMs > THIRTY_DAYS_MS);

    const sourceEvents = db.prepare('SELECT * FROM user_events WHERE user_id = ? ORDER BY recorded_at').all(source);
    const targetEvents = db.prepare('SELECT * FROM user_events WHERE user_id = ?').all(target);
    const targetByIdempotency = new Map(targetEvents.filter((row) => row.idempotency_key).map((row) => [row.idempotency_key, row]));
    const targetByFingerprint = new Map(targetEvents.map((row) => [eventFingerprint(row), row]));

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO user_merges (merge_id, source_user_id, target_user_id, status, merged_at)
        VALUES (?, ?, ?, 'completed', ?)
      `).run(mergeId, source, target, now);

      if (profileMerge.changed || (!targetProfile && sourceProfile)) {
        const nextVersion = (targetProfile?.profileVersion || 0) + 1;
        upsertProfileStmt.run(
          target,
          nextVersion,
          JSON.stringify(profileMerge.merged),
          targetProfile?.createdAt || now,
          now
        );
        insertRevisionStmt.run(
          crypto.randomUUID(), target, nextVersion, JSON.stringify(profileMerge.merged),
          JSON.stringify(['guest_merge_fill']), 'system', now
        );
      }

      for (const conflict of profileMerge.conflicts) {
        db.prepare(`
          INSERT INTO profile_merge_conflicts
            (conflict_id, merge_id, field_path, account_value_json, guest_value_json,
             account_updated_at, guest_updated_at, account_stale_over_30_days,
             resolution_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          crypto.randomUUID(), mergeId, conflict.fieldPath,
          JSON.stringify(conflict.accountValue), JSON.stringify(conflict.guestValue),
          targetProfile?.updatedAt || null, sourceProfile?.updatedAt || null,
          accountStale ? 1 : 0, now
        );
      }

      for (const row of sourceEvents) {
        const fingerprint = eventFingerprint(row);
        const duplicate = (row.idempotency_key && targetByIdempotency.get(row.idempotency_key)) ||
          targetByFingerprint.get(fingerprint);
        if (duplicate) {
          db.prepare(`
            INSERT INTO event_merge_audit
              (audit_id, merge_id, source_event_id, target_event_id, action, event_hash, created_at)
            VALUES (?, ?, ?, ?, 'deduplicated', ?, ?)
          `).run(crypto.randomUUID(), mergeId, row.event_id, duplicate.event_id, fingerprint, now);
          continue;
        }
        const nextStatus = SENSITIVE_EVENT_TYPES.has(row.event_type) ? 'restricted_pending_consent' : row.status;
        db.prepare('UPDATE user_events SET user_id = ?, status = ? WHERE event_id = ?')
          .run(target, nextStatus, row.event_id);
        db.prepare(`
          INSERT INTO event_merge_audit
            (audit_id, merge_id, source_event_id, target_event_id, action, event_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), mergeId, row.event_id, row.event_id,
          nextStatus === 'restricted_pending_consent' ? 'migrated_restricted' : 'migrated',
          fingerprint, now
        );
      }

      db.prepare('UPDATE user_identities SET user_id = ?, last_seen_at = ? WHERE user_id = ?')
        .run(target, now, source);
      db.prepare("UPDATE users SET account_status = 'merged', merged_into_user_id = ? WHERE user_id = ?")
        .run(target, source);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return getUserMerge(target, source);
  }

  function getMergeReview(userId, mergeId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const merge = mapMerge(selectUserMergeByIdStmt.get(String(mergeId || '').trim()));
    if (!merge || merge.targetUserId !== normalizedUserId) return null;
    const conflicts = selectProfileConflictsStmt.all(mergeId).map((row) => ({
      conflictId: row.conflict_id,
      fieldPath: row.field_path,
      accountValue: JSON.parse(row.account_value_json),
      guestValue: JSON.parse(row.guest_value_json),
      accountUpdatedAt: row.account_updated_at,
      guestUpdatedAt: row.guest_updated_at,
      accountStaleOver30Days: Boolean(row.account_stale_over_30_days),
      resolutionStatus: row.resolution_status,
      createdAt: row.created_at,
    }));
    const eventAudit = selectEventMergeAuditStmt.all(mergeId).map((row) => ({
      sourceEventId: row.source_event_id,
      targetEventId: row.target_event_id,
      action: row.action,
      eventHash: row.event_hash,
      createdAt: row.created_at,
    }));
    return { mergeId, conflicts, eventAudit };
  }

  function releaseMergedSensitiveEvents(userId, mergeId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return db.prepare(`
      UPDATE user_events SET status = 'active'
      WHERE user_id = ? AND status = 'restricted_pending_consent' AND event_id IN (
        SELECT target_event_id FROM event_merge_audit
        WHERE merge_id = ? AND action = 'migrated_restricted'
      )
    `).run(normalizedUserId, mergeId).changes;
  }

  function recordEnergyCalculation(userId, calculation, { now = new Date().toISOString() } = {}) {
    const normalizedUserId = ensureUser(userId, { now });
    assertUserWritable(normalizedUserId);
    const calculationId = crypto.randomUUID();
    insertEnergyCalculationStmt.run(
      calculationId,
      normalizedUserId,
      calculation.formulaId,
      calculation.formulaVersion,
      JSON.stringify(calculation.inputs),
      JSON.stringify(calculation.assumptions || []),
      JSON.stringify(calculation.outputs),
      JSON.stringify(calculation.sourceRefs || []),
      now
    );
    return listEnergyCalculations(normalizedUserId, { limit: 1 })[0];
  }

  function listEnergyCalculations(userId, { limit = 20 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    return selectEnergyCalculationsStmt.all(normalizedUserId, safeLimit).map((row) => ({
      calculationId: row.calculation_id,
      userId: normalizedUserId,
      formulaId: row.formula_id,
      formulaVersion: row.formula_version,
      inputs: JSON.parse(row.inputs_json),
      assumptions: JSON.parse(row.assumptions_json),
      outputs: JSON.parse(row.outputs_json),
      sourceRefs: JSON.parse(row.source_refs_json),
      createdAt: row.created_at,
    }));
  }

  function mapPlan(row, userId) {
    if (!row) return null;
    return {
      planId: row.plan_id,
      userId,
      planVersion: row.plan_version,
      status: row.status,
      calculationId: row.calculation_id,
      parentPlanId: row.parent_plan_id,
      plan: JSON.parse(row.plan_json),
      changeReason: row.change_reason,
      createdAt: row.created_at,
      activatedAt: row.activated_at,
      pausedAt: row.paused_at,
      completedAt: row.completed_at,
    };
  }

  function getPlan(userId, planId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return mapPlan(selectPlanStmt.get(normalizedUserId, planId), normalizedUserId);
  }

  function getActivePlan(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return mapPlan(selectActivePlanStmt.get(normalizedUserId), normalizedUserId);
  }

  function listPlans(userId, { limit = 50 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return selectPlansStmt.all(normalizedUserId, safeLimit).map((row) => mapPlan(row, normalizedUserId));
  }

  function createPlanDraft(userId, input, { now = new Date().toISOString() } = {}) {
    const normalizedUserId = ensureUser(userId, { now });
    assertUserWritable(normalizedUserId);
    if (input.calculationId) {
      const calculation = db.prepare(`
        SELECT calculation_id FROM energy_calculations WHERE user_id = ? AND calculation_id = ?
      `).get(normalizedUserId, input.calculationId);
      if (!calculation) throw new Error('计划引用的计算记录不存在或不属于当前用户');
    }
    if (input.parentPlanId && !getPlan(normalizedUserId, input.parentPlanId)) {
      throw new Error('上一版本计划不存在或不属于当前用户');
    }
    const nextVersion = db.prepare(`
      SELECT COALESCE(MAX(plan_version), 0) + 1 AS next_version
      FROM user_plan_versions WHERE user_id = ?
    `).get(normalizedUserId).next_version;
    const planId = crypto.randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO user_plan_versions
          (plan_id, user_id, plan_version, status, calculation_id, parent_plan_id,
           plan_json, change_reason, created_at, activated_at, paused_at, completed_at)
        VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(
        planId, normalizedUserId, nextVersion, input.calculationId || null,
        input.parentPlanId || null, JSON.stringify(input.plan), input.changeReason, now
      );
      db.prepare(`
        INSERT INTO plan_state_transitions
          (transition_id, plan_id, user_id, from_status, to_status, reason, occurred_at)
        VALUES (?, ?, ?, NULL, 'draft', 'plan_draft_created', ?)
      `).run(crypto.randomUUID(), planId, normalizedUserId, now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return getPlan(normalizedUserId, planId);
  }

  function transitionPlan(userId, planId, toStatus, {
    reason,
    now = new Date().toISOString(),
  } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    assertUserWritable(normalizedUserId);
    const current = getPlan(normalizedUserId, planId);
    if (!current) throw new Error('计划不存在或不属于当前用户');
    const allowed = {
      draft: ['active'],
      active: ['paused', 'superseded', 'completed'],
      paused: ['active', 'superseded', 'completed'],
      superseded: [],
      completed: [],
    };
    if (!allowed[current.status]?.includes(toStatus)) {
      throw new Error(`计划不能从${current.status}切换到${toStatus}`);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      if (toStatus === 'active') {
        const existingActive = getActivePlan(normalizedUserId);
        if (existingActive && existingActive.planId !== planId) {
          db.prepare(`
            UPDATE user_plan_versions SET status = 'superseded', completed_at = ?
            WHERE plan_id = ?
          `).run(now, existingActive.planId);
          db.prepare(`
            INSERT INTO plan_state_transitions
              (transition_id, plan_id, user_id, from_status, to_status, reason, occurred_at)
            VALUES (?, ?, ?, 'active', 'superseded', ?, ?)
          `).run(crypto.randomUUID(), existingActive.planId, normalizedUserId, `replaced_by:${planId}`, now);
        }
        const parentPlan = current.parentPlanId
          ? getPlan(normalizedUserId, current.parentPlanId)
          : null;
        if (parentPlan && parentPlan.status === 'paused' && parentPlan.planId !== existingActive?.planId) {
          db.prepare(`
            UPDATE user_plan_versions SET status = 'superseded', completed_at = ?
            WHERE plan_id = ? AND user_id = ? AND status = 'paused'
          `).run(now, parentPlan.planId, normalizedUserId);
          db.prepare(`
            INSERT INTO plan_state_transitions
              (transition_id, plan_id, user_id, from_status, to_status, reason, occurred_at)
            VALUES (?, ?, ?, 'paused', 'superseded', ?, ?)
          `).run(crypto.randomUUID(), parentPlan.planId, normalizedUserId, `replaced_by:${planId}`, now);
        }
      }
      db.prepare(`
        UPDATE user_plan_versions SET status = ?,
          activated_at = CASE WHEN ? = 'active' THEN COALESCE(activated_at, ?) ELSE activated_at END,
          paused_at = CASE WHEN ? = 'paused' THEN ? WHEN ? = 'active' THEN NULL ELSE paused_at END,
          completed_at = CASE WHEN ? IN ('superseded', 'completed') THEN ? ELSE completed_at END
        WHERE plan_id = ? AND user_id = ?
      `).run(toStatus, toStatus, now, toStatus, now, toStatus, toStatus, now, planId, normalizedUserId);
      db.prepare(`
        INSERT INTO plan_state_transitions
          (transition_id, plan_id, user_id, from_status, to_status, reason, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), planId, normalizedUserId, current.status, toStatus, reason || 'unspecified', now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return getPlan(normalizedUserId, planId);
  }

  function activateInitialPlanAndTrial(userId, planId, {
    trialStartedAt,
    trialEndsAt,
    renewalReminderAt,
  } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    assertUserWritable(normalizedUserId);
    const currentPlan = getPlan(normalizedUserId, planId);
    const currentService = getServiceStatus(normalizedUserId);
    if (!currentPlan) throw new Error('正式计划不存在或不属于当前用户');
    if (currentPlan.status === 'active' && currentService?.status === 'trial_active') return currentPlan;
    if (currentPlan.status !== 'draft') throw new Error('首个长期计划必须从草稿状态交付');
    if (currentService?.status !== 'profile_confirmed') {
      throw new Error(`启动首个长期体验不允许从${currentService?.status || 'free'}状态执行`);
    }
    for (const [label, value] of Object.entries({ trialStartedAt, trialEndsAt, renewalReminderAt })) {
      if (!value || Number.isNaN(new Date(value).getTime())) throw new Error(`${label}格式不正确`);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE user_plan_versions
        SET status = 'active', activated_at = ?, paused_at = NULL
        WHERE plan_id = ? AND user_id = ? AND status = 'draft'
      `).run(trialStartedAt, planId, normalizedUserId);
      db.prepare(`
        INSERT INTO plan_state_transitions
          (transition_id, plan_id, user_id, from_status, to_status, reason, occurred_at)
        VALUES (?, ?, ?, 'draft', 'active', 'official_plan_delivered', ?)
      `).run(crypto.randomUUID(), planId, normalizedUserId, trialStartedAt);
      upsertServiceStatusStmt.run(
        normalizedUserId,
        'trial_active',
        trialStartedAt,
        trialEndsAt,
        renewalReminderAt,
        planId,
        trialStartedAt
      );
      insertServiceTransitionStmt.run(
        crypto.randomUUID(),
        normalizedUserId,
        'profile_confirmed',
        'trial_active',
        'first_official_plan_delivered',
        trialStartedAt
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return getPlan(normalizedUserId, planId);
  }

  function listPlanTransitions(userId, planId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return selectPlanTransitionsStmt.all(normalizedUserId, planId).map((row) => ({
      transitionId: row.transition_id,
      planId,
      userId: normalizedUserId,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      occurredAt: row.occurred_at,
    }));
  }

  function getPlanRevisionCommand(userId, commandId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const row = selectPlanRevisionCommandStmt.get(normalizedUserId, commandId);
    if (!row) return null;
    return {
      commandId: row.command_id,
      userId: normalizedUserId,
      planId: row.plan_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function recordPlanRevisionCommand(userId, commandId, {
    planId = null,
    status,
    now = new Date().toISOString(),
  } = {}) {
    const normalizedUserId = ensureUser(userId, { now });
    if (typeof commandId !== 'string' || !commandId.trim()) throw new Error('新版命令ID不能为空');
    if (!['draft_created', 'delivered'].includes(status)) throw new Error('新版命令状态不正确');
    upsertPlanRevisionCommandStmt.run(commandId, normalizedUserId, planId, status, now, now);
    return getPlanRevisionCommand(normalizedUserId, commandId);
  }

  function mapNotification(row) {
    if (!row) return null;
    return {
      notificationId: row.notification_id,
      userId: row.user_id,
      notificationType: row.notification_type,
      dedupeKey: row.dedupe_key,
      scheduledAt: row.scheduled_at,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    };
  }

  function enqueueDueRenewalReminders({ now = new Date().toISOString(), limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const dueUsers = selectDueRenewalUsersStmt.all(now, now, safeLimit);
    const notifications = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of dueUsers) {
        const dedupeKey = `renewal-day-13:${row.trial_started_at}`;
        insertNotificationStmt.run(
          crypto.randomUUID(),
          row.user_id,
          'trial_renewal_day_13',
          dedupeKey,
          row.renewal_reminder_at,
          now
        );
        notifications.push(mapNotification(selectNotificationByDedupeStmt.get(row.user_id, dedupeKey)));
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return notifications;
  }

  function listPendingNotifications({ now = new Date().toISOString(), limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return selectPendingNotificationsStmt.all(now, safeLimit).map(mapNotification);
  }

  function markNotificationSent(notificationId, { sentAt = new Date().toISOString() } = {}) {
    if (typeof notificationId !== 'string' || !notificationId.trim()) {
      throw new Error('提醒ID不能为空');
    }
    const result = markNotificationSentStmt.run(sentAt, notificationId.trim());
    return result.changes === 1;
  }

  function updateProfile(userId, patch, { source = 'user', now = new Date().toISOString(), expectedVersion = null } = {}) {
    const normalizedUserId = ensureUser(userId, { now });
    assertUserWritable(normalizedUserId);
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
    assertUserWritable(parsed.userId);
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
      FROM user_events WHERE user_id = ? AND event_id = ? AND status = 'active'
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
          FROM user_events WHERE user_id = ? AND event_type = ? AND status = 'active'
          ORDER BY occurred_at DESC LIMIT ?
        `).all(normalizedUserId, eventType, safeLimit)
      : db.prepare(`
          SELECT event_id, event_type, occurred_at, recorded_at, payload_json, source,
                 idempotency_key, supersedes_event_id, status
          FROM user_events WHERE user_id = ? AND status = 'active'
          ORDER BY occurred_at DESC LIMIT ?
        `).all(normalizedUserId, safeLimit);
    return rows.map((row) => mapEventRow(normalizedUserId, row));
  }

  function mapAdviceRow(userId, row) {
    if (!row) return null;
    return {
      adviceId: row.advice_id,
      userId,
      adviceType: row.advice_type,
      serviceMode: row.service_mode,
      content: row.content,
      metadata: JSON.parse(row.metadata_json),
      threadId: row.thread_id,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    };
  }

  function recordAdvice(userId, {
    adviceType = 'meal_advice', serviceMode = 'free', content, metadata = {},
    threadId = null, idempotencyKey, createdAt = new Date().toISOString(),
  } = {}) {
    const normalizedUserId = ensureUser(userId, { now: createdAt });
    assertUserWritable(normalizedUserId);
    const normalizedContent = String(content || '').trim();
    const normalizedKey = String(idempotencyKey || '').trim();
    if (!normalizedContent) throw new Error('建议内容不能为空');
    if (!normalizedKey) throw new Error('建议幂等键不能为空');
    insertAdviceStmt.run(
      crypto.randomUUID(), normalizedUserId, adviceType, serviceMode,
      normalizedContent, JSON.stringify(metadata || {}), threadId,
      normalizedKey, createdAt
    );
    return mapAdviceRow(
      normalizedUserId,
      selectAdviceByIdempotencyStmt.get(normalizedUserId, normalizedKey)
    );
  }

  function listAdviceHistory(userId, { limit = 50 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return selectAdviceHistoryStmt.all(normalizedUserId, safeLimit)
      .map((row) => mapAdviceRow(normalizedUserId, row));
  }

  function listUserSummaries({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return db.prepare(`
      SELECT u.user_id, u.last_active_at, u.created_at,
             COALESCE(p.profile_version, 0) profile_version,
             COALESCE(s.status, 'free') service_status,
             (SELECT COUNT(*) FROM user_advice_history a WHERE a.user_id=u.user_id) advice_count,
             (SELECT COUNT(*) FROM user_events e WHERE e.user_id=u.user_id AND e.status='active') event_count,
             (SELECT COUNT(*) FROM user_plan_versions v WHERE v.user_id=u.user_id) plan_count,
             (SELECT COUNT(*) FROM energy_calculations c WHERE c.user_id=u.user_id) calculation_count
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id=u.user_id
      LEFT JOIN user_service_status s ON s.user_id=u.user_id
      ORDER BY u.last_active_at DESC LIMIT ?
    `).all(safeLimit).map((row) => ({
      userId: row.user_id,
      lastActiveAt: row.last_active_at,
      createdAt: row.created_at,
      profileVersion: row.profile_version,
      serviceStatus: row.service_status,
      adviceCount: row.advice_count,
      eventCount: row.event_count,
      planCount: row.plan_count,
      calculationCount: row.calculation_count,
    }));
  }

  function getUserDataSnapshot(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return {
      userId: normalizedUserId,
      profile: getProfile(normalizedUserId),
      profileRevisions: listProfileRevisions(normalizedUserId, { limit: 100 }),
      serviceStatus: getServiceStatus(normalizedUserId),
      adviceHistory: listAdviceHistory(normalizedUserId, { limit: 100 }),
      events: listEvents(normalizedUserId, { limit: 200 }),
      energyCalculations: listEnergyCalculations(normalizedUserId, { limit: 100 }),
      plans: listPlans(normalizedUserId, { limit: 100 }),
      serviceTransitions: listServiceTransitions(normalizedUserId, { limit: 100 }),
    };
  }

  function recordConsent(input) {
    const parsed = ConsentSchema.parse(input);
    ensureUser(parsed.userId, { now: parsed.recordedAt });
    assertUserWritable(parsed.userId);
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
    resolveAnonymousIdentity,
    getServiceStatus,
    setServiceStatus,
    listServiceTransitions,
    getUserMerge,
    mergeAnonymousIntoAccount,
    getMergeReview,
    releaseMergedSensitiveEvents,
    recordEnergyCalculation,
    listEnergyCalculations,
    createPlanDraft,
    getPlan,
    getActivePlan,
    listPlans,
    transitionPlan,
    activateInitialPlanAndTrial,
    listPlanTransitions,
    getPlanRevisionCommand,
    recordPlanRevisionCommand,
    enqueueDueRenewalReminders,
    listPendingNotifications,
    markNotificationSent,
    getProfile,
    updateProfile,
    listProfileRevisions,
    appendEvent,
    getEvent,
    listEvents,
    recordAdvice,
    listAdviceHistory,
    listUserSummaries,
    getUserDataSnapshot,
    getUserSettings,
    updateUserTimezone,
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
