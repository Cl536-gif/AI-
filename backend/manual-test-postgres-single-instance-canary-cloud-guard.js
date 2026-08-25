const assert = require('assert');
const {
  CONFIRMATION,
  assert005bCanaryEnvironment,
} = require('./manual-test-postgres-single-instance-canary-cloud');

const validEnv = {
  RUN_005B_CANARY_VERIFY: CONFIRMATION,
  USER_STORE_ADAPTER: 'tencent-postgres',
  TENCENT_PG_CUTOVER_MODE: 'single_instance_canary',
  TENCENT_PG_CUTOVER_CONFIRM: 'postgres-single-instance-canary',
  TENCENT_PG_CANARY_MAX_INSTANCES: '1',
  TENCENT_PG_HOST: '10.0.0.8',
  TENCENT_PG_PORT: '5432',
  TENCENT_PG_DATABASE: 'diet_secretary',
  TENCENT_PG_USER: 'diet_app',
  TENCENT_PG_PASSWORD: 'test-only-password',
  TENCENT_PG_SSL_MODE: 'disable',
  TENCENT_PG_POOL_MAX: '1',
  TENCENT_PG_IDLE_TIMEOUT_MS: '30000',
  TENCENT_PG_CONNECT_TIMEOUT_MS: '5000',
  TENCENT_PG_STATEMENT_TIMEOUT_MS: '10000',
  TENCENT_PG_LOCK_TIMEOUT_MS: '3000',
  TENCENT_PG_IDLE_TX_TIMEOUT_MS: '15000',
};

const result = assert005bCanaryEnvironment(validEnv);
assert.strictEqual(result.config.poolMax, 1);
assert.strictEqual(result.gate.maxInstances, 1);

assert.throws(
  () => assert005bCanaryEnvironment({ ...validEnv, RUN_005B_CANARY_VERIFY: '' }),
  (error) => error.code === 'VERIFY_CONFIRMATION_REQUIRED'
);
assert.throws(
  () => assert005bCanaryEnvironment({ ...validEnv, USER_STORE_ADAPTER: 'sqlite' }),
  (error) => error.code === 'POSTGRES_CANARY_ADAPTER_REQUIRED'
);
assert.throws(
  () => assert005bCanaryEnvironment({ ...validEnv, TENCENT_PG_HOST: '203.0.113.8' }),
  (error) => error.code === 'PRIVATE_IPV4_REQUIRED'
);
assert.throws(
  () => assert005bCanaryEnvironment({ ...validEnv, TENCENT_PG_POOL_MAX: '2' }),
  (error) => error.code === 'POSTGRES_CANARY_SCOPE_INVALID'
);

console.log(JSON.stringify({
  batch: '005b-postgres-single-instance-canary',
  check: 'local_cloud_guard',
  status: 'PASS',
  networkUsed: false,
}));
