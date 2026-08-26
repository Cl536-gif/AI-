const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CLOUD_CONFIRMATION,
  DEDICATED_CONFIRMATION,
  REVIEW_CONFIRMATION,
  TRANSPORT_CONFIRMATION,
} = require('./src/db/postgresBackupRecoveryGate');
const {
  assert005lCloudEnvironment,
} = require('./manual-test-postgres-backup-restore-cloud');

const pem = [
  '-----BEGIN CERTIFICATE-----',
  'MIIB',
  '-----END CERTIFICATE-----',
].join('\n');

const validEnv = {
  RUN_005L_BACKUP_RECOVERY_REVIEW: REVIEW_CONFIRMATION,
  RUN_005L_BACKUP_RECOVERY_VERIFY: CLOUD_CONFIRMATION,
  RUN_005L_DEDICATED_RESTORE: DEDICATED_CONFIRMATION,
  RUN_005L_TRANSPORT_SECURITY: TRANSPORT_CONFIRMATION,
  USER_STORE_ADAPTER: 'sqlite',
  TENCENT_PG_BACKUP_FORMAT: 'physical',
  TENCENT_PG_LOG_BACKUP_ENABLED: 'true',
  TENCENT_PG_RESTORE_MODE: 'point_in_time_isolated_clone',
  TENCENT_PG_DATA_RETENTION_DAYS: '30',
  TENCENT_PG_LOG_RETENTION_DAYS: '30',
  TENCENT_PG_MAX_BACKUP_AGE_HOURS: '72',
  TENCENT_PG_LATEST_SUCCESSFUL_BACKUP_AGE_HOURS: '12',
  TENCENT_PG_RPO_TARGET_MINUTES: '30',
  TENCENT_PG_RTO_TARGET_MINUTES: '120',
  TENCENT_PG_005L_BEFORE_MARKER_AT: '2026-08-26T08:00:00Z',
  TENCENT_PG_005L_RECOVERY_TARGET_AT: '2026-08-26T08:01:00Z',
  TENCENT_PG_005L_AFTER_MARKER_AT: '2026-08-26T08:02:00Z',
  TENCENT_PG_005L_FAILURE_OBSERVED_AT: '2026-08-26T08:03:00Z',
  TENCENT_PG_005L_RESTORE_STARTED_AT: '2026-08-26T08:04:00Z',
  TENCENT_PG_005L_RESTORE_VERIFIED_AT: '2026-08-26T08:34:00Z',
  TENCENT_PG_SOURCE_HOST_SHA256: 'a'.repeat(64),
  TENCENT_PG_HOST: '10.0.0.9',
  TENCENT_PG_PORT: '5432',
  TENCENT_PG_DATABASE: 'diet_secretary',
  TENCENT_PG_USER: 'diet_app',
  TENCENT_PG_PASSWORD: 'not-a-real-password',
  TENCENT_PG_SSL_MODE: 'verify-full',
  TENCENT_PG_SSL_CA_BASE64: Buffer.from(pem).toString('base64'),
  TENCENT_PG_POOL_MAX: '1',
  TENCENT_PG_005L_SOURCE_TABLE_COUNT: '23',
  TENCENT_PG_005L_SOURCE_FUNCTION_COUNT: '14',
  TENCENT_PG_005L_SOURCE_CONSTRAINT_COUNT: '42',
};

function expectCode(env, code) {
  assert.throws(() => assert005lCloudEnvironment(env), (error) => error?.code === code);
}

const verified = assert005lCloudEnvironment(validEnv);
assert.strictEqual(verified.observation.observedRpoMinutes, 2);
assert.strictEqual(verified.observation.observedRtoMinutes, 30);
expectCode({ ...validEnv, RUN_005L_BACKUP_RECOVERY_VERIFY: '' }, 'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005L_DEDICATED_RESTORE: '' }, 'DEDICATED_RESTORE_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_LOG_BACKUP_ENABLED: 'false' }, 'LOG_BACKUP_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_LOG_RETENTION_DAYS: '7' }, 'LOG_RETENTION_TOO_SHORT');
expectCode({ ...validEnv, TENCENT_PG_SSL_MODE: 'require' }, 'VERIFY_FULL_TLS_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_POOL_MAX: '2' }, 'RESTORE_POOL_MAX_MUST_BE_ONE');
expectCode(
  { ...validEnv, TENCENT_PG_005L_RECOVERY_TARGET_AT: '2026-08-26T08:03:30Z' },
  'RECOVERY_TARGET_OUTSIDE_MARKERS'
);
expectCode(
  { ...validEnv, TENCENT_PG_RPO_TARGET_MINUTES: '1' },
  'RPO_TARGET_EXCEEDED'
);

const sqlRoot = path.join(__dirname, 'sql/postgres');
const preflight = fs.readFileSync(path.join(sqlRoot, '005l_backup_restore_preflight.review.sql'), 'utf8');
const seed = fs.readFileSync(path.join(sqlRoot, '005l_backup_restore_seed.review.sql'), 'utf8');
const cutoff = fs.readFileSync(path.join(sqlRoot, '005l_backup_restore_cutoff.review.sql'), 'utf8');
const cleanup = fs.readFileSync(path.join(sqlRoot, '005l_backup_restore_cleanup.review.sql'), 'utf8');

assert(preflight.includes('SET TRANSACTION READ ONLY'));
assert(preflight.includes("THEN 'PASS'"));
assert(preflight.includes("ELSE 'BLOCKED'"));
assert(preflight.includes("current_setting('ssl') = 'on'"));
assert(preflight.includes("c.relkind IN ('r', 'p')"));
assert(!preflight.includes('information_schema.tables'));
assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(
  preflight.replace(/^--.*$/gm, '')
));
assert(seed.includes('backup_recovery_canary_005l'));
assert(seed.includes('REVOKE ALL'));
assert(seed.includes('GRANT SELECT'));
assert(cutoff.includes('recommended_recovery_target_at'));
assert(cleanup.includes('DROP TABLE app.backup_recovery_canary_005l'));
assert(!cleanup.includes('CASCADE'));

const cloudVerifier = fs.readFileSync(
  path.join(__dirname, 'manual-test-postgres-backup-restore-cloud.js'),
  'utf8'
);
assert(cloudVerifier.includes("c.relkind IN ('r', 'p')"));
assert(!cloudVerifier.includes('information_schema.tables'));

console.log(JSON.stringify({
  batch: '005l-postgres-backup-restore-cloud',
  check: 'local_cloud_guard',
  status: 'PASS',
  physicalBackupRequired: true,
  logBackupRequired: true,
  isolatedPitrRequired: true,
  verifyFullTlsRequired: true,
  sourceAndRestoreMustDiffer: true,
  rpoRtoTargetsRequired: true,
  dmsPreflightReadOnly: true,
  cleanupScopeFixed: true,
  networkUsed: false,
}));
