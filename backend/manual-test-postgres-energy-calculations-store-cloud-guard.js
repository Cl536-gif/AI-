const assert = require('assert');
const {
  CONFIRMATION,
  assert004fCloudEnvironment,
} = require('./manual-test-postgres-energy-calculations-store-cloud');

const validEnv = {
  RUN_004F_ENERGY_CALCULATIONS_VERIFY: CONFIRMATION,
  USER_STORE_ADAPTER: 'sqlite',
  TENCENT_PG_HOST: '10.0.0.8',
  TENCENT_PG_PORT: '5432',
  TENCENT_PG_DATABASE: 'diet_secretary',
  TENCENT_PG_USER: 'diet_app',
  TENCENT_PG_PASSWORD: 'test-only-password',
  TENCENT_PG_SSL_MODE: 'disable',
  TENCENT_PG_POOL_MAX: '5',
  TENCENT_PG_IDLE_TIMEOUT_MS: '30000',
  TENCENT_PG_CONNECT_TIMEOUT_MS: '5000',
  TENCENT_PG_STATEMENT_TIMEOUT_MS: '10000',
  TENCENT_PG_LOCK_TIMEOUT_MS: '3000',
  TENCENT_PG_IDLE_TX_TIMEOUT_MS: '15000',
};

const config = assert004fCloudEnvironment(validEnv);
assert.strictEqual(config.poolMax, 1);
assert.strictEqual(config.connectTimeoutMs, 750);

assert.throws(
  () => assert004fCloudEnvironment({
    ...validEnv,
    RUN_004F_ENERGY_CALCULATIONS_VERIFY: '',
  }),
  (error) => error.code === 'VERIFY_CONFIRMATION_REQUIRED'
);
assert.throws(
  () => assert004fCloudEnvironment({
    ...validEnv,
    USER_STORE_ADAPTER: 'tencent-postgres',
  }),
  (error) => error.code === 'USER_STORE_MUST_REMAIN_SQLITE'
);
assert.throws(
  () => assert004fCloudEnvironment({
    ...validEnv,
    TENCENT_PG_HOST: '203.0.113.8',
  }),
  (error) => error.code === 'PRIVATE_IPV4_REQUIRED'
);

console.log(JSON.stringify({
  batch: '004f-adapter-cloud',
  check: 'local_cloud_guard',
  status: 'PASS',
  networkUsed: false,
}));
