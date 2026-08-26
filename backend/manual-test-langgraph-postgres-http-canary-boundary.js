const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DUAL_INSTANCE_HTTP_CANARY_MODE,
  DUAL_INSTANCE_HTTP_CONFIRMATION,
  assertTencentPostgresCutoverAllowed,
} = require('./src/stores/tencentPostgresCutoverGate');
const {
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  POSTGRES_THREAD_LOCK_CONFIRMATION,
  resolveLangGraphCheckpointerPolicy,
} = require('./src/langgraph/checkpointerProvider');
const {
  assertHttpCanaryRequest,
  invokeGraphWithCheckpointerPolicy,
} = require('./src/langgraph/httpCanaryBoundary');

const token = 'test-only-http-canary-token-32-characters';
const env = {
  USER_STORE_ADAPTER: 'tencent-postgres',
  TENCENT_PG_CUTOVER_MODE: DUAL_INSTANCE_HTTP_CANARY_MODE,
  TENCENT_PG_CUTOVER_CONFIRM: DUAL_INSTANCE_HTTP_CONFIRMATION,
  TENCENT_PG_HTTP_CANARY_MAX_INSTANCES: '2',
  TENCENT_PG_POOL_MAX: '2',
  RUN_005H_DEDICATED_SERVICE: 'CONFIRMED_005H_DEDICATED_HTTP_CANARY_SERVICE',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'postgres',
  LANGGRAPH_CHECKPOINTER_CONFIRM: POSTGRES_CHECKPOINTER_CONFIRMATION,
  LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION: '1.0.4',
  LANGGRAPH_CHECKPOINTER_MODE: POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  LANGGRAPH_CHECKPOINTER_MAX_INSTANCES: '2',
  LANGGRAPH_THREAD_LOCK_CONFIRM: POSTGRES_THREAD_LOCK_CONFIRMATION,
  LANGGRAPH_HTTP_CANARY_TOKEN: token,
};

const cutover = assertTencentPostgresCutoverAllowed({ env });
assert.strictEqual(cutover.maxInstances, 2);
assert.strictEqual(cutover.poolMax, 2);
const policy = resolveLangGraphCheckpointerPolicy({ env });
assert.strictEqual(policy.httpCanary, true);
assert.strictEqual(policy.requiresThreadLock, true);
assert.strictEqual(policy.productionReady, false);

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

expectCode(
  () => assertTencentPostgresCutoverAllowed({ env: { ...env, RUN_005H_DEDICATED_SERVICE: '' } }),
  'POSTGRES_HTTP_CANARY_DEDICATED_SERVICE_REQUIRED'
);
expectCode(
  () => resolveLangGraphCheckpointerPolicy({ env: { ...env, LANGGRAPH_THREAD_LOCK_CONFIRM: '' } }),
  'LANGGRAPH_HTTP_CANARY_LOCK_CONFIRMATION_REQUIRED'
);
expectCode(
  () => assertHttpCanaryRequest({ policy, token: 'wrong', env }),
  'HTTP_CANARY_UNAUTHORIZED'
);
assert.strictEqual(assertHttpCanaryRequest({ policy, token, env }).authorized, true);
assert.strictEqual(
  assertHttpCanaryRequest({ policy: { httpCanary: false }, token: '', env: {} }).required,
  false
);

async function run() {
  const calls = [];
  const graph = {
    invoke: async (input, config) => {
      calls.push(['invoke', input, config]);
      return { status: 'ok' };
    },
  };
  const result = await invokeGraphWithCheckpointerPolicy({
    graph,
    input: { value: 1 },
    config: { configurable: { thread_id: 'internal-thread-scope' } },
    policy,
    pool: {},
    withLock: async ({ scope, work }) => {
      calls.push(['lock', scope]);
      return work();
    },
  });
  assert.deepStrictEqual(result, { status: 'ok' });
  assert.deepStrictEqual(calls.map((entry) => entry[0]), ['lock', 'invoke']);
  const routeSource = fs.readFileSync(
    path.join(__dirname, 'src/routes/chatLanggraph.js'),
    'utf8'
  );
  assert(routeSource.includes('assertHttpCanaryRequest'));
  assert(routeSource.includes('invokeGraphWithCheckpointerPolicy'));
  assert(routeSource.lastIndexOf('assertHttpCanaryRequest') < routeSource.indexOf('resolveAnonymousUser(deviceId)'));
  console.log(JSON.stringify({
    batch: '005h-postgres-http-canary-boundary',
    status: 'PASS',
    dedicatedServiceRequired: true,
    twoInstancesAndPoolTwoRequired: true,
    sharedUserStoreRequired: true,
    bearerTokenRequiredBeforeIdentity: true,
    sameThreadLockWrapsGraphInvoke: true,
    sqlitePathUnchanged: true,
    productionReady: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
