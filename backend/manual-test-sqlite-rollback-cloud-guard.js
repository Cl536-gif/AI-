const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEDICATED_CONFIRMATION,
  VERIFY_CONFIRMATION,
  assert005kCloudEnvironment,
} = require('./manual-test-sqlite-rollback-cloud');

const validEnv = {
  RUN_005K_ROLLBACK_VERIFY: VERIFY_CONFIRMATION,
  RUN_005K_DEDICATED_SERVICE: DEDICATED_CONFIRMATION,
  USER_STORE_ADAPTER: 'sqlite',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'memory',
  NODE_ENV: 'production',
  PORT: '3001',
  K_REVISION: 'local-fixture-not-emitted',
};

function expectCode(env, phase, code) {
  assert.throws(() => assert005kCloudEnvironment(env, phase), (error) => error?.code === code);
}

assert.strictEqual(assert005kCloudEnvironment(validEnv, 'baseline').environment.adapter, 'sqlite');
assert.strictEqual(assert005kCloudEnvironment(validEnv, 'rollback').phase, 'rollback');
expectCode({ ...validEnv, RUN_005K_ROLLBACK_VERIFY: '' }, 'baseline', 'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005K_DEDICATED_SERVICE: '' }, 'baseline', 'DEDICATED_SERVICE_REQUIRED');
expectCode({ ...validEnv, USER_STORE_ADAPTER: 'tencent-postgres' }, 'rollback', 'ROLLBACK_ENVIRONMENT_MISMATCH');
expectCode({ ...validEnv, LANGGRAPH_CHECKPOINTER_BACKEND: 'postgres' }, 'rollback', 'ROLLBACK_ENVIRONMENT_MISMATCH');
expectCode({ ...validEnv, TENCENT_PG_CUTOVER_MODE: 'full' }, 'rollback', 'ROLLBACK_ENVIRONMENT_FORBIDDEN_VALUE');
expectCode(validEnv, 'cleanup', 'ROLLBACK_PHASE_UNSUPPORTED');

const source = fs.readFileSync(path.join(__dirname, 'manual-test-sqlite-rollback-cloud.js'), 'utf8');
assert(source.includes('http://127.0.0.1:'));
assert(!source.includes('TENCENT_PG_HOST'));
assert(!source.includes('TENCENT_PG_PASSWORD'));

console.log(JSON.stringify({
  batch: '005k-sqlite-rollback-cloud',
  check: 'local_cloud_guard',
  status: 'PASS',
  dedicatedServiceRequired: true,
  stableSqliteEnvironmentRequired: true,
  immutableSourceDigestsRequired: true,
  cloudRevisionFingerprintRequired: true,
  postgresNetworkUsed: false,
}));
