const REVIEW_CONFIRMATION = 'CONFIRMED_005L_BACKUP_RECOVERY_REVIEW';
const CLOUD_CONFIRMATION = 'CONFIRMED_005L_BACKUP_RECOVERY_CLOUD';
const DEDICATED_CONFIRMATION = 'CONFIRMED_005L_ISOLATED_RESTORE_SERVICE';
const TRANSPORT_CONFIRMATION = 'CONFIRMED_005L_VERIFY_FULL_TLS';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function read(env, name) {
  return String(env[name] ?? '').trim();
}

function requireExact(env, name, expected, code) {
  if (read(env, name) !== expected) fail(code);
}

function parseInteger(env, name, { min, max }) {
  const raw = read(env, name);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) fail('BACKUP_POLICY_INTEGER_INVALID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('BACKUP_POLICY_RANGE_INVALID');
  }
  return value;
}

function parseIsoTimestamp(env, name) {
  const raw = read(env, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) {
    fail('RECOVERY_TIMESTAMP_INVALID');
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) fail('RECOVERY_TIMESTAMP_INVALID');
  return value;
}

function differenceMinutes(later, earlier) {
  return Math.ceil((later - earlier) / 60000);
}

function parseBackupPolicy(env = process.env) {
  requireExact(
    env,
    'RUN_005L_BACKUP_RECOVERY_REVIEW',
    REVIEW_CONFIRMATION,
    'BACKUP_RECOVERY_REVIEW_REQUIRED'
  );
  if (read(env, 'TENCENT_PG_BACKUP_FORMAT') !== 'physical') {
    fail('PHYSICAL_BACKUP_REQUIRED');
  }
  if (read(env, 'TENCENT_PG_LOG_BACKUP_ENABLED') !== 'true') {
    fail('LOG_BACKUP_REQUIRED');
  }
  if (read(env, 'TENCENT_PG_RESTORE_MODE') !== 'point_in_time_isolated_clone') {
    fail('ISOLATED_PITR_REQUIRED');
  }

  const dataRetentionDays = parseInteger(env, 'TENCENT_PG_DATA_RETENTION_DAYS', {
    min: 7,
    max: 3650,
  });
  const logRetentionDays = parseInteger(env, 'TENCENT_PG_LOG_RETENTION_DAYS', {
    min: 7,
    max: 3650,
  });
  if (logRetentionDays < dataRetentionDays) fail('LOG_RETENTION_TOO_SHORT');

  const maximumBackupAgeHours = parseInteger(env, 'TENCENT_PG_MAX_BACKUP_AGE_HOURS', {
    min: 1,
    max: 84,
  });
  const latestSuccessfulBackupAgeHours = parseInteger(
    env,
    'TENCENT_PG_LATEST_SUCCESSFUL_BACKUP_AGE_HOURS',
    { min: 0, max: 720 }
  );
  if (latestSuccessfulBackupAgeHours > maximumBackupAgeHours) {
    fail('LATEST_BACKUP_TOO_OLD');
  }

  return Object.freeze({
    dataRetentionDays,
    logRetentionDays,
    maximumBackupAgeHours,
    latestSuccessfulBackupAgeHours,
    rpoTargetMinutes: parseInteger(env, 'TENCENT_PG_RPO_TARGET_MINUTES', {
      min: 1,
      max: 1440,
    }),
    rtoTargetMinutes: parseInteger(env, 'TENCENT_PG_RTO_TARGET_MINUTES', {
      min: 1,
      max: 1440,
    }),
  });
}

function parseRecoveryObservation(env = process.env) {
  const beforeMarkerAt = parseIsoTimestamp(env, 'TENCENT_PG_005L_BEFORE_MARKER_AT');
  const afterMarkerAt = parseIsoTimestamp(env, 'TENCENT_PG_005L_AFTER_MARKER_AT');
  const recoveryTargetAt = parseIsoTimestamp(env, 'TENCENT_PG_005L_RECOVERY_TARGET_AT');
  const failureObservedAt = parseIsoTimestamp(env, 'TENCENT_PG_005L_FAILURE_OBSERVED_AT');
  const restoreStartedAt = parseIsoTimestamp(env, 'TENCENT_PG_005L_RESTORE_STARTED_AT');
  const restoreVerifiedAt = parseIsoTimestamp(env, 'TENCENT_PG_005L_RESTORE_VERIFIED_AT');

  if (!(beforeMarkerAt < recoveryTargetAt && recoveryTargetAt < afterMarkerAt)) {
    fail('RECOVERY_TARGET_OUTSIDE_MARKERS');
  }
  if (failureObservedAt < afterMarkerAt) fail('FAILURE_OBSERVATION_TOO_EARLY');
  if (restoreStartedAt < failureObservedAt) fail('RESTORE_STARTED_BEFORE_FAILURE');
  if (restoreVerifiedAt < restoreStartedAt) fail('RESTORE_VERIFIED_BEFORE_START');

  return Object.freeze({
    beforeMarkerAt,
    afterMarkerAt,
    recoveryTargetAt,
    failureObservedAt,
    restoreStartedAt,
    restoreVerifiedAt,
    observedRpoMinutes: differenceMinutes(failureObservedAt, recoveryTargetAt),
    observedRtoMinutes: differenceMinutes(restoreVerifiedAt, restoreStartedAt),
  });
}

function assertBackupRecoveryAllowed(env = process.env) {
  const policy = parseBackupPolicy(env);
  requireExact(
    env,
    'RUN_005L_BACKUP_RECOVERY_VERIFY',
    CLOUD_CONFIRMATION,
    'VERIFY_CONFIRMATION_REQUIRED'
  );
  requireExact(
    env,
    'RUN_005L_DEDICATED_RESTORE',
    DEDICATED_CONFIRMATION,
    'DEDICATED_RESTORE_REQUIRED'
  );
  requireExact(
    env,
    'RUN_005L_TRANSPORT_SECURITY',
    TRANSPORT_CONFIRMATION,
    'TLS_REVIEW_REQUIRED'
  );
  if (read(env, 'USER_STORE_ADAPTER').toLowerCase() !== 'sqlite') {
    fail('SQLITE_PRODUCTION_REQUIRED');
  }
  if (read(env, 'TENCENT_PG_SSL_MODE').toLowerCase() !== 'verify-full') {
    fail('VERIFY_FULL_TLS_REQUIRED');
  }
  if (!/^[a-f0-9]{64}$/.test(read(env, 'TENCENT_PG_SOURCE_HOST_SHA256'))) {
    fail('SOURCE_HOST_FINGERPRINT_REQUIRED');
  }

  const observation = parseRecoveryObservation(env);
  if (observation.observedRpoMinutes > policy.rpoTargetMinutes) {
    fail('RPO_TARGET_EXCEEDED');
  }
  if (observation.observedRtoMinutes > policy.rtoTargetMinutes) {
    fail('RTO_TARGET_EXCEEDED');
  }

  return Object.freeze({ policy, observation });
}

module.exports = {
  CLOUD_CONFIRMATION,
  DEDICATED_CONFIRMATION,
  REVIEW_CONFIRMATION,
  TRANSPORT_CONFIRMATION,
  assertBackupRecoveryAllowed,
  parseBackupPolicy,
  parseRecoveryObservation,
};
