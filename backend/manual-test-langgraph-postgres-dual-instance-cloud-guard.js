const assert = require('assert');
const {
  CONFIRMATION,
  DEDICATED_SERVICE_CONFIRMATION,
  assertReaderPrecondition,
  assert005fCloudEnvironment,
  resolveInstanceFingerprint,
} = require('./manual-test-langgraph-postgres-dual-instance-cloud');

const validEnv = {
  RUN_005F_DUAL_INSTANCE_VERIFY: CONFIRMATION,
  RUN_005F_DEDICATED_SERVICE: DEDICATED_SERVICE_CONFIRMATION,
  USER_STORE_ADAPTER: 'sqlite',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'memory',
  LANGGRAPH_DUAL_INSTANCE_CANARY_DECLARED_INSTANCES: '2',
  LANGGRAPH_DUAL_INSTANCE_CANARY_RUN_ID: '005f-local-guard-01',
  LANGGRAPH_THREAD_HMAC_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HOSTNAME: '005f-local-instance-a',
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

const result = assert005fCloudEnvironment(validEnv, 'writer');
assert.strictEqual(result.phase, 'writer');
assert.strictEqual(result.runId, '005f-local-guard-01');
assert.strictEqual(result.config.poolMax, 1);
assert.notStrictEqual(
  resolveInstanceFingerprint(validEnv),
  resolveInstanceFingerprint({ ...validEnv, HOSTNAME: '005f-local-instance-b' })
);

function expectCode(env, phase, code) {
  assert.throws(
    () => assert005fCloudEnvironment(env, phase),
    (error) => error?.code === code
  );
}

expectCode({ ...validEnv, RUN_005F_DUAL_INSTANCE_VERIFY: '' }, 'writer', 'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005F_DEDICATED_SERVICE: '' }, 'writer', 'DEDICATED_VALIDATION_SERVICE_REQUIRED');
expectCode({ ...validEnv, USER_STORE_ADAPTER: 'tencent-postgres' }, 'writer', 'USER_STORE_MUST_REMAIN_SQLITE');
expectCode({ ...validEnv, LANGGRAPH_CHECKPOINTER_BACKEND: 'postgres' }, 'writer', 'RUNTIME_CHECKPOINTER_MUST_REMAIN_MEMORY');
expectCode({ ...validEnv, LANGGRAPH_DUAL_INSTANCE_CANARY_DECLARED_INSTANCES: '1' }, 'writer', 'DUAL_INSTANCE_DECLARATION_REQUIRED');
expectCode({ ...validEnv, LANGGRAPH_DUAL_INSTANCE_CANARY_RUN_ID: 'short' }, 'writer', 'VERIFY_RUN_ID_INVALID');
expectCode({ ...validEnv, HOSTNAME: '' }, 'writer', 'INSTANCE_HOSTNAME_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_HOST: '203.0.113.8' }, 'writer', 'PRIVATE_IPV4_REQUIRED');
expectCode(validEnv, 'unknown', 'VERIFY_PHASE_INVALID');

const persistedWriterState = {
  checkpoint: {
    channel_values: {
      count: 2,
      instanceFingerprints: ['writer-instance-fingerprint'],
    },
  },
};
assert.deepStrictEqual(
  assertReaderPrecondition(persistedWriterState, 'reader-instance-fingerprint'),
  persistedWriterState.checkpoint.channel_values
);
assert.throws(
  () => assertReaderPrecondition(persistedWriterState, 'writer-instance-fingerprint'),
  (error) => error?.code === 'CP_INSTANCE_NOT_DISTINCT'
);
assert.strictEqual(persistedWriterState.checkpoint.channel_values.count, 2);

console.log(JSON.stringify({
  batch: '005f-dual-instance-checkpointer-cloud',
  check: 'local_cloud_guard',
  status: 'PASS',
  dedicatedServiceRequired: true,
  userStoreRemainsSqlite: true,
  runtimeCheckpointerRemainsMemory: true,
  declaredInstancesRequired: 2,
  distinctInstanceFingerprintVerified: true,
  sameInstanceRejectedBeforeWrite: true,
  privateNetworkRequired: true,
  networkUsed: false,
}));
