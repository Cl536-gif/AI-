const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONFIRMATION,
  DEDICATED_CONFIRMATION,
  FIXED_DEVICE_ID,
  LIVE_WINDOW_CONFIRMATION,
  MIN_OBSERVATION_MINUTES,
  MIN_REQUEST_COUNT,
  assert005pCloudEnvironment,
  collectPreproductionObservation,
} = require('./manual-test-postgres-preproduction-observation-cloud');
const {
  DUAL_INSTANCE_HTTP_CANARY_MODE,
  DUAL_INSTANCE_HTTP_CONFIRMATION,
} = require('./src/stores/tencentPostgresCutoverGate');
const {
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  POSTGRES_THREAD_LOCK_CONFIRMATION,
} = require('./src/langgraph/checkpointerProvider');

const validEnv = {
  RUN_005P_PREPRODUCTION_VERIFY: CONFIRMATION,
  RUN_005P_DEDICATED_SERVICE: DEDICATED_CONFIRMATION,
  RUN_005P_LIVE_WINDOW: LIVE_WINDOW_CONFIRMATION,
  PREPRODUCTION_005P_RUN_ID: '005p-cloud-20260827-01',
  PREPRODUCTION_005P_BASE_URL: 'https://005p.example.sh.run.tcloudbase.com',
  PREPRODUCTION_005P_OBSERVATION_MINUTES: '60',
  PREPRODUCTION_005P_REQUEST_COUNT: '100',
  RUN_005H_DEDICATED_SERVICE: 'CONFIRMED_005H_DEDICATED_HTTP_CANARY_SERVICE',
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
  LANGGRAPH_THREAD_HMAC_SECRET: 'test-only-005p-hmac-secret-at-least-32-characters',
  LANGGRAPH_HTTP_CANARY_TOKEN: 'test-only-005p-http-token-at-least-32-characters',
  BAILIAN_API_KEY: 'sk-test-only-not-a-real-credential',
  BAILIAN_APP_ID: 'test-only-app-id',
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

const verified = assert005pCloudEnvironment(validEnv, 'observe');
assert.strictEqual(verified.observationMinutes, MIN_OBSERVATION_MINUTES);
assert.strictEqual(verified.requestCount, MIN_REQUEST_COUNT);
assert.strictEqual(verified.baseUrl, validEnv.PREPRODUCTION_005P_BASE_URL);
assert.strictEqual(assert005pCloudEnvironment(validEnv, 'cleanup-checkpointer').phase,
  'cleanup-checkpointer');

function expectCode(env, phase, code) {
  assert.throws(
    () => assert005pCloudEnvironment(env, phase),
    (error) => error?.code === code
  );
}

expectCode({ ...validEnv, RUN_005P_PREPRODUCTION_VERIFY: '' }, 'observe',
  'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005P_DEDICATED_SERVICE: '' }, 'observe',
  'DEDICATED_SERVICE_REQUIRED');
expectCode({ ...validEnv, RUN_005P_LIVE_WINDOW: '' }, 'observe',
  'LIVE_WINDOW_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, PREPRODUCTION_005P_OBSERVATION_MINUTES: '59' }, 'observe',
  'PREPRODUCTION_OBSERVATION_CONFIGURATION_INVALID');
expectCode({ ...validEnv, PREPRODUCTION_005P_REQUEST_COUNT: '99' }, 'observe',
  'PREPRODUCTION_OBSERVATION_CONFIGURATION_INVALID');
expectCode({ ...validEnv, PREPRODUCTION_005P_BASE_URL: 'http://example.com' }, 'observe',
  'PREPRODUCTION_BASE_URL_INVALID');
expectCode({ ...validEnv, TENCENT_PG_POOL_MAX: '1' }, 'observe',
  'POSTGRES_HTTP_CANARY_SCOPE_INVALID');
expectCode({ ...validEnv, BAILIAN_API_KEY: '' }, 'observe', 'BAILIAN_CREDENTIALS_REQUIRED');

const routeSource = fs.readFileSync(
  path.join(__dirname, 'src/routes/chatLanggraph.js'),
  'utf8'
);
assert(routeSource.includes('canaryPoolWaiting: getPostgresPool().waitingCount'));

const postgresDir = path.join(__dirname, 'sql', 'postgres');
const preflight = fs.readFileSync(
  path.join(postgresDir, '005p_preproduction_observation_preflight.review.sql'),
  'utf8'
);
const cleanup = fs.readFileSync(
  path.join(postgresDir, '005p_preproduction_observation_cleanup.review.sql'),
  'utf8'
);
assert(preflight.includes(FIXED_DEVICE_ID));
assert(cleanup.includes(FIXED_DEVICE_ID));
assert(cleanup.includes("thread_id LIKE '005p-observe-005p-cloud-%'"));
assert(cleanup.includes('v_advice_count < 100'));
assert(!/DELETE\s+FROM\s+app\.[A-Za-z0-9_]+\s*;/i.test(cleanup));
assert(!/TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE/i.test(cleanup));

async function runFakeWindow() {
  let clock = 0;
  const baseWall = Date.parse('2026-08-27T00:00:00.000Z');
  let chatIndex = 0;
  const response = (status, body) => ({
    status,
    text: async () => JSON.stringify(body),
  });
  const result = await collectPreproductionObservation({
    verified,
    token: validEnv.LANGGRAPH_HTTP_CANARY_TOKEN,
    monotonicNow: () => clock,
    wallNow: () => baseWall + clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async (url) => {
      if (url.includes('/api/ready')) return response(200, { status: 'ready' });
      const index = chatIndex;
      chatIndex += 1;
      return response(200, {
        identityStatus: 'anonymous_resolved',
        advicePersistence: 'recorded',
        canaryPoolWaiting: 0,
        canaryInstanceFingerprint: (index % 2 === 0 ? 'a' : 'b').repeat(64),
      });
    },
  });
  assert.strictEqual(result.observationMinutes, 60);
  assert.strictEqual(result.requestCount, 100);
  assert.strictEqual(result.successfulRequests, 100);
  assert.strictEqual(result.instanceCount, 2);
  assert.strictEqual(result.poolWaitingMax, 0);
  assert.strictEqual(result.responseContentEmitted, false);
}

runFakeWindow()
  .then(() => console.log(JSON.stringify({
    batch: '005p-preproduction-observation',
    check: 'local_cloud_guard',
    status: 'PASS',
    dedicatedServiceRequired: true,
    publicCloudBaseHttpsRequired: true,
    twoInstancesAndPoolTwoRequired: true,
    minimumObservationMinutes: 60,
    minimumRequestCount: 100,
    sevenZeroSignalsRequired: true,
    exactCleanupRequired: true,
    responseContentEmitted: false,
    networkUsed: false,
  })))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
