const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  classifyBailianFailure,
  runBailianDependencyProbe,
} = require('./src/monitoring/bailianDependencyMonitor');
const {
  DEDICATED_CONFIRMATION,
  LIVE_PROBE_CONFIRMATION,
  VERIFY_CONFIRMATION,
  assert005oCloudEnvironment,
} = require('./manual-test-bailian-model-monitor-cloud');

const validEnv = {
  RUN_005O_MODEL_MONITOR_VERIFY: VERIFY_CONFIRMATION,
  RUN_005O_DEDICATED_SERVICE: DEDICATED_CONFIRMATION,
  RUN_005O_LIVE_PROBE: LIVE_PROBE_CONFIRMATION,
  USER_STORE_ADAPTER: 'sqlite',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'memory',
  BAILIAN_API_KEY: 'sk-test-value-not-a-real-secret',
  BAILIAN_APP_ID: 'test-app-id',
  BAILIAN_MONITOR_TIMEOUT_MS: '5000',
};

function expectCode(env, code) {
  assert.throws(() => assert005oCloudEnvironment(env), (error) => error?.code === code);
}

assert.strictEqual(assert005oCloudEnvironment(validEnv).verified, true);
expectCode({ ...validEnv, RUN_005O_MODEL_MONITOR_VERIFY: '' }, 'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005O_DEDICATED_SERVICE: '' }, 'DEDICATED_SERVICE_REQUIRED');
expectCode({ ...validEnv, RUN_005O_LIVE_PROBE: '' }, 'LIVE_PROBE_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, USER_STORE_ADAPTER: 'tencent-postgres' }, 'SQLITE_PRODUCTION_PATH_REQUIRED');
expectCode({ ...validEnv, LANGGRAPH_CHECKPOINTER_BACKEND: 'postgres' }, 'MEMORY_CHECKPOINTER_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_CUTOVER_MODE: 'full' }, 'PRODUCTION_CUTOVER_CONFIGURATION_FORBIDDEN');

assert.strictEqual(classifyBailianFailure({
  status: 400,
  body: { error: { message: 'Access denied, account is not in good standing; overdue-payment' } },
}), 'BAILIAN_MONITOR_ACCOUNT_STANDING_FAILED');
assert.strictEqual(classifyBailianFailure({
  status: 401,
  body: { message: 'Invalid API-key provided.' },
}), 'BAILIAN_MONITOR_AUTHENTICATION_FAILED');
assert.strictEqual(classifyBailianFailure({ status: 429 }), 'BAILIAN_MONITOR_RATE_LIMITED');
assert.strictEqual(classifyBailianFailure({ status: 503 }), 'BAILIAN_MONITOR_UPSTREAM_UNAVAILABLE');
assert.strictEqual(classifyBailianFailure({ error: { name: 'AbortError' } }), 'BAILIAN_MONITOR_TIMEOUT');
assert.strictEqual(classifyBailianFailure({ error: new Error('network') }), 'BAILIAN_MONITOR_NETWORK_FAILED');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function main() {
  const calls = [];
  const result = await runBailianDependencyProbe({
    env: validEnv,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response(200, { output: { text: 'OK' } });
      return response(200, { choices: [{ message: { content: 'OK' } }] });
    },
  });
  assert.strictEqual(result.appProbe.status, 'healthy');
  assert.strictEqual(result.genericProbe.status, 'healthy');
  assert.strictEqual(result.responseContentEmitted, false);
  assert.strictEqual(calls.length, 2);
  assert(calls.every(({ options }) => options.headers.Authorization.startsWith('Bearer ')));
  assert(calls.every(({ options }) => !options.body.includes(validEnv.BAILIAN_API_KEY)));

  await assert.rejects(
    runBailianDependencyProbe({
      env: validEnv,
      fetchImpl: async () => response(400, {
        error: { message: 'Access denied; account not in good standing; overdue-payment' },
      }),
    }),
    (error) => error?.code === 'BAILIAN_MONITOR_ACCOUNT_STANDING_FAILED'
  );

  const cloudSource = fs.readFileSync(
    path.join(__dirname, 'manual-test-bailian-model-monitor-cloud.js'),
    'utf8'
  );
  assert(!cloudSource.includes('apiKey: result'));
  assert(!cloudSource.includes('reply:'));

  console.log(JSON.stringify({
    batch: '005o-bailian-model-monitor',
    check: 'local_cloud_guard',
    status: 'PASS',
    applicationAndGenericProbesRequired: true,
    accountStandingFailureClassified: true,
    authenticationFailureClassified: true,
    rateLimitFailureClassified: true,
    timeoutFailureClassified: true,
    upstreamFailureClassified: true,
    responseContentEmitted: false,
    productionUserStoreRemainsSqlite: true,
    networkUsed: false,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
