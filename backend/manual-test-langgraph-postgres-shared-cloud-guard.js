const assert = require('assert');
const {
  CONFIRMATION,
  assert005eCloudEnvironment,
} = require('./manual-test-langgraph-postgres-shared-cloud');

const validEnv = {
  RUN_005E_SHARED_CHECKPOINTER_VERIFY: CONFIRMATION,
  USER_STORE_ADAPTER: 'sqlite',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'postgres',
  LANGGRAPH_CHECKPOINTER_CONFIRM: 'postgres-shared-checkpointer',
  LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION: '1.0.4',
  LANGGRAPH_CHECKPOINTER_MODE: 'single_instance_canary',
  LANGGRAPH_CHECKPOINTER_MAX_INSTANCES: '1',
  LANGGRAPH_THREAD_HMAC_SECRET: 'test-only-secret-that-is-at-least-32-characters',
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

const result = assert005eCloudEnvironment(validEnv, 'seed');
assert.strictEqual(result.phase, 'seed');
assert.strictEqual(result.policy.shared, true);
assert.strictEqual(result.config.poolMax, 1);

assert.throws(
  () => assert005eCloudEnvironment({
    ...validEnv,
    RUN_005E_SHARED_CHECKPOINTER_VERIFY: '',
  }, 'seed'),
  (error) => error?.code === 'VERIFY_CONFIRMATION_REQUIRED'
);
assert.throws(
  () => assert005eCloudEnvironment({ ...validEnv, USER_STORE_ADAPTER: 'tencent-postgres' }, 'seed'),
  (error) => error?.code === 'USER_STORE_MUST_REMAIN_SQLITE'
);
assert.throws(
  () => assert005eCloudEnvironment({ ...validEnv, TENCENT_PG_HOST: '203.0.113.8' }, 'seed'),
  (error) => error?.code === 'PRIVATE_IPV4_REQUIRED'
);
assert.throws(
  () => assert005eCloudEnvironment({
    ...validEnv,
    LANGGRAPH_THREAD_HMAC_SECRET: 'short',
  }, 'seed'),
  (error) => error?.code === 'LANGGRAPH_THREAD_SCOPE_SECRET_INVALID'
);
assert.throws(
  () => assert005eCloudEnvironment(validEnv, 'unknown'),
  (error) => error?.code === 'VERIFY_PHASE_INVALID'
);

console.log(JSON.stringify({
  batch: '005e-shared-checkpointer-cloud',
  check: 'local_cloud_guard',
  status: 'PASS',
  userStoreRemainsSqlite: true,
  privateNetworkRequired: true,
  threadScopeSecretRequired: true,
  networkUsed: false,
}));
