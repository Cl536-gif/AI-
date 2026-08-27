const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONTROL_PLANE_CONFIRMATION,
  DEDICATED_CONFIRMATION,
  VERIFY_CONFIRMATION,
  assert005nCloudEnvironment,
} = require('./manual-test-cloudbase-rollback-control-cloud');

const policy = {
  RUN_005I_ROLLBACK_POLICY: 'CONFIRMED_005I_AUTOMATIC_ROLLBACK_SIGNALS',
  TENCENT_PG_ROLLBACK_MIN_SAMPLES: '100',
  TENCENT_PG_ROLLBACK_POOL_SATURATION_PCT: '90',
  TENCENT_PG_ROLLBACK_WAITING_CLIENTS: '2',
  TENCENT_PG_ROLLBACK_READINESS_FAILURES: '3',
  TENCENT_PG_ROLLBACK_CONNECTION_TIMEOUT_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_TRANSACTION_FAILURE_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_HTTP_SIDE_EFFECT_FAILURE_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_IDENTITY_FAILURE_RATE_PCT: '5',
};
const stableFingerprint = 'a'.repeat(64);
const canaryFingerprint = 'b'.repeat(64);
const shared = {
  RUN_005N_ROLLBACK_CONTROL_VERIFY: VERIFY_CONFIRMATION,
  RUN_005N_DEDICATED_SERVICE: DEDICATED_CONFIRMATION,
  CLOUDBASE_ROLLBACK_RUN_ID: '005n-cloud-20260827-01',
  USER_STORE_ADAPTER: 'sqlite',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'memory',
  NODE_ENV: 'production',
  PORT: '3001',
  ...policy,
};
const stable = {
  ...shared,
  CLOUDBASE_ROLLBACK_REHEARSAL_ROLE: 'stable',
  K_REVISION: 'stable-revision-fixture',
};
const canary = {
  ...shared,
  CLOUDBASE_ROLLBACK_REHEARSAL_ROLE: 'canary',
  CLOUDBASE_005N_STABLE_REVISION_FINGERPRINT: stableFingerprint,
  K_REVISION: 'canary-revision-fixture',
};
const verifiedRollback = {
  ...stable,
  CLOUDBASE_005N_STABLE_REVISION_FINGERPRINT: stableFingerprint,
  CLOUDBASE_005N_CANARY_REVISION_FINGERPRINT: canaryFingerprint,
  RUN_005N_CONTROL_PLANE_ACTION: CONTROL_PLANE_CONFIRMATION,
  K_REVISION: 'fixture-that-does-not-match-a-hash',
};
verifiedRollback.CLOUDBASE_005N_STABLE_REVISION_FINGERPRINT = require('./src/release/sqliteRollbackArtifact')
  .sha256(verifiedRollback.K_REVISION);

function expectCode(env, phase, code) {
  assert.throws(
    () => assert005nCloudEnvironment(env, phase),
    (error) => error?.code === code
  );
}

assert.strictEqual(assert005nCloudEnvironment(stable, 'baseline').role, 'stable');
assert.strictEqual(assert005nCloudEnvironment(canary, 'signal').role, 'canary');
assert.strictEqual(assert005nCloudEnvironment(verifiedRollback, 'verify').phase, 'verify');
expectCode({ ...stable, RUN_005N_ROLLBACK_CONTROL_VERIFY: '' }, 'baseline', 'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...stable, RUN_005N_DEDICATED_SERVICE: '' }, 'baseline', 'DEDICATED_SERVICE_REQUIRED');
expectCode({ ...stable, CLOUDBASE_ROLLBACK_RUN_ID: 'bad' }, 'baseline', 'ROLLBACK_RUN_ID_INVALID');
expectCode({ ...stable, CLOUDBASE_ROLLBACK_REHEARSAL_ROLE: 'canary' }, 'baseline', 'ROLLBACK_REVISION_ROLE_MISMATCH');
expectCode({ ...canary, USER_STORE_ADAPTER: 'tencent-postgres' }, 'signal', 'ROLLBACK_ENVIRONMENT_MISMATCH');
expectCode(
  {
    ...canary,
    CLOUDBASE_005N_STABLE_REVISION_FINGERPRINT: require('./src/release/sqliteRollbackArtifact')
      .sha256(canary.K_REVISION),
  },
  'signal',
  'CANARY_REVISION_NOT_DISTINCT'
);
expectCode({ ...verifiedRollback, RUN_005N_CONTROL_PLANE_ACTION: '' }, 'verify', 'CONTROL_PLANE_ACTION_CONFIRMATION_REQUIRED');
expectCode(
  { ...verifiedRollback, CLOUDBASE_005N_STABLE_REVISION_FINGERPRINT: stableFingerprint },
  'verify',
  'STABLE_REVISION_NOT_RESTORED'
);
expectCode(stable, 'cleanup', 'ROLLBACK_CONTROL_PHASE_UNSUPPORTED');

const source = fs.readFileSync(
  path.join(__dirname, 'manual-test-cloudbase-rollback-control-cloud.js'),
  'utf8'
);
assert(source.includes('http://127.0.0.1:'));
assert(!source.includes('TENCENT_PG_PASSWORD'));
assert(!source.includes('cloud.tencent.com/api'));

console.log(JSON.stringify({
  batch: '005n-cloudbase-rollback-control',
  check: 'local_cloud_guard',
  status: 'PASS',
  dedicatedServiceRequired: true,
  sameServiceRevisionTransitionRequired: true,
  rollbackSignalRequired: true,
  manualControlPlaneActionRequired: true,
  stableRevisionFingerprintRequired: true,
  productionUserStoreRemainsSqlite: true,
  postgresNetworkUsed: false,
}));
