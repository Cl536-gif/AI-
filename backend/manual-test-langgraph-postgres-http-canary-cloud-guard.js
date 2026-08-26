const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONFIRMATION,
  DUAL_INSTANCE_HTTP_CANARY_MODE,
  DUAL_INSTANCE_HTTP_CONFIRMATION,
  FIXED_DEVICE_ID,
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  POSTGRES_THREAD_LOCK_CONFIRMATION,
  assert005hCloudEnvironment,
  assertLinearCheckpointChain,
  postCanary,
  resolveInstanceFingerprint,
} = require('./manual-test-langgraph-postgres-http-canary-cloud');
const { FAULT_CONFIRMATION } = require('./src/langgraph/httpCanaryBoundary');

const validEnv = {
  RUN_005H_HTTP_VERIFY: CONFIRMATION,
  RUN_005H_DEDICATED_SERVICE: 'CONFIRMED_005H_DEDICATED_HTTP_CANARY_SERVICE',
  RUN_005H_FAULT_INJECTION: FAULT_CONFIRMATION,
  USER_STORE_ADAPTER: 'tencent-postgres',
  TENCENT_PG_CUTOVER_MODE: DUAL_INSTANCE_HTTP_CANARY_MODE,
  TENCENT_PG_CUTOVER_CONFIRM: DUAL_INSTANCE_HTTP_CONFIRMATION,
  TENCENT_PG_HTTP_CANARY_MAX_INSTANCES: '2',
  TENCENT_PG_POOL_MAX: '2',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'postgres',
  LANGGRAPH_CHECKPOINTER_CONFIRM: POSTGRES_CHECKPOINTER_CONFIRMATION,
  LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION: '1.0.4',
  LANGGRAPH_CHECKPOINTER_MODE: POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  LANGGRAPH_CHECKPOINTER_MAX_INSTANCES: '2',
  LANGGRAPH_THREAD_LOCK_CONFIRM: POSTGRES_THREAD_LOCK_CONFIRMATION,
  LANGGRAPH_THREAD_HMAC_SECRET: 'test-only-005h-hmac-secret-at-least-32-characters',
  LANGGRAPH_HTTP_CANARY_TOKEN: 'test-only-005h-http-token-at-least-32-characters',
  LANGGRAPH_HTTP_CANARY_RUN_ID: '005h-local-guard-01',
  HOSTNAME: '005h-local-instance-a',
  PORT: '3001',
  TENCENT_PG_HOST: '10.0.0.8',
  TENCENT_PG_PORT: '5432',
  TENCENT_PG_DATABASE: 'diet_secretary',
  TENCENT_PG_USER: 'diet_app',
  TENCENT_PG_PASSWORD: 'test-only-password',
  TENCENT_PG_SSL_MODE: 'disable',
  TENCENT_PG_IDLE_TIMEOUT_MS: '30000',
  TENCENT_PG_CONNECT_TIMEOUT_MS: '5000',
  TENCENT_PG_STATEMENT_TIMEOUT_MS: '10000',
  TENCENT_PG_LOCK_TIMEOUT_MS: '3000',
  TENCENT_PG_IDLE_TX_TIMEOUT_MS: '15000',
};

const verified = assert005hCloudEnvironment(validEnv, 'writer');
assert.strictEqual(verified.localUrl, 'http://127.0.0.1:3001/api/chat-langgraph');
assert.strictEqual(verified.policy.httpCanary, true);
assert.strictEqual(verified.policy.productionReady, false);
assert.strictEqual(resolveInstanceFingerprint(validEnv).length, 64);
assert.notStrictEqual(
  resolveInstanceFingerprint(validEnv),
  resolveInstanceFingerprint({ ...validEnv, HOSTNAME: '005h-local-instance-b' })
);

function expectCode(env, phase, code) {
  assert.throws(
    () => assert005hCloudEnvironment(env, phase),
    (error) => error?.code === code
  );
}

expectCode({ ...validEnv, RUN_005H_HTTP_VERIFY: '' }, 'writer', 'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005H_FAULT_INJECTION: '' }, 'writer', 'FAULT_INJECTION_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, USER_STORE_ADAPTER: 'sqlite' }, 'writer', 'LANGGRAPH_HTTP_CANARY_POSTGRES_STORE_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_POOL_MAX: '1' }, 'writer', 'POSTGRES_HTTP_CANARY_SCOPE_INVALID');
expectCode({ ...validEnv, LANGGRAPH_CHECKPOINTER_MAX_INSTANCES: '1' }, 'writer', 'LANGGRAPH_CHECKPOINTER_SCOPE_INVALID');
expectCode({ ...validEnv, LANGGRAPH_HTTP_CANARY_TOKEN: 'short' }, 'writer', 'HTTP_TOKEN_REQUIRED');
expectCode(validEnv, 'unknown', 'VERIFY_PHASE_INVALID');

assert.deepStrictEqual(assertLinearCheckpointChain([
  { config: { configurable: { checkpoint_id: '2' } }, parentConfig: { configurable: { checkpoint_id: '1' } } },
  { config: { configurable: { checkpoint_id: '1' } } },
]), { checkpointCount: 2, branchCount: 0 });
assert.throws(
  () => assertLinearCheckpointChain([
    { config: { configurable: { checkpoint_id: '3' } }, parentConfig: { configurable: { checkpoint_id: '1' } } },
    { config: { configurable: { checkpoint_id: '2' } }, parentConfig: { configurable: { checkpoint_id: '1' } } },
    { config: { configurable: { checkpoint_id: '1' } } },
  ]),
  (error) => error?.code === 'CP_BRANCH_DETECTED'
);

const postgresDir = path.join(__dirname, 'sql', 'postgres');
const preflight = fs.readFileSync(path.join(postgresDir, '005h_http_canary_preflight.review.sql'), 'utf8');
const cleanup = fs.readFileSync(path.join(postgresDir, '005h_http_canary_cleanup.review.sql'), 'utf8');
assert(preflight.includes(FIXED_DEVICE_ID));
assert(cleanup.includes(FIXED_DEVICE_ID));
assert(cleanup.includes("idempotency_key NOT LIKE '005h-marker:%'"));
assert(cleanup.includes("idempotency_key LIKE '005h-marker:%'"));
assert(cleanup.includes('source_user_id = v_user_id OR target_user_id = v_user_id'));
assert(!/DELETE\s+FROM\s+app\.[A-Za-z0-9_]+\s*;/i.test(cleanup));
assert(!/TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE/i.test(cleanup));

async function testHttpHelper() {
  const calls = [];
  const result = await postCanary({
    url: verified.localUrl,
    token: validEnv.LANGGRAPH_HTTP_CANARY_TOKEN,
    threadId: '005h-http-local-test',
    message: 'test',
    holdMs: 500,
    fault: 'after-identity',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { status: 503, text: async () => JSON.stringify({ code: 'HTTP_CANARY_FAULT_AFTER_IDENTITY' }) };
    },
  });
  assert.strictEqual(result.status, 503);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.headers['x-diet-canary-hold-ms'], '500');
  assert.strictEqual(calls[0].options.headers['x-diet-canary-fault'], 'after-identity');
}

testHttpHelper()
  .then(() => console.log(JSON.stringify({
    batch: '005h-http-canary-cloud',
    check: 'local_cloud_guard',
    status: 'PASS',
    fixedIdentityOnly: true,
    localHttpOnly: true,
    twoInstancesAndPoolTwoRequired: true,
    tokenAndFaultConfirmationsRequired: true,
    distinctInstanceFingerprintsAvailable: true,
    linearCheckpointChainRequired: true,
    exactCleanupRequired: true,
    networkUsed: false,
  })))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
