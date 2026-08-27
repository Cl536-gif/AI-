const {
  runBailianDependencyProbe,
} = require('./src/monitoring/bailianDependencyMonitor');

const VERIFY_CONFIRMATION = 'CONFIRMED_005O_BAILIAN_MODEL_MONITOR';
const DEDICATED_CONFIRMATION = 'CONFIRMED_005O_DEDICATED_MODEL_MONITOR_SERVICE';
const LIVE_PROBE_CONFIRMATION = 'CONFIRMED_005O_LIVE_BAILIAN_PROBE';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function assert005oCloudEnvironment(env = process.env) {
  if (String(env.RUN_005O_MODEL_MONITOR_VERIFY || '').trim() !== VERIFY_CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.RUN_005O_DEDICATED_SERVICE || '').trim() !== DEDICATED_CONFIRMATION) {
    fail('DEDICATED_SERVICE_REQUIRED');
  }
  if (String(env.RUN_005O_LIVE_PROBE || '').trim() !== LIVE_PROBE_CONFIRMATION) {
    fail('LIVE_PROBE_CONFIRMATION_REQUIRED');
  }
  if (String(env.USER_STORE_ADAPTER || 'sqlite').trim().toLowerCase() !== 'sqlite') {
    fail('SQLITE_PRODUCTION_PATH_REQUIRED');
  }
  if (String(env.LANGGRAPH_CHECKPOINTER_BACKEND || 'memory').trim().toLowerCase() !== 'memory') {
    fail('MEMORY_CHECKPOINTER_REQUIRED');
  }
  for (const name of [
    'TENCENT_PG_CUTOVER_MODE',
    'TENCENT_PG_CUTOVER_CONFIRM',
    'LANGGRAPH_CHECKPOINTER_CONFIRM',
    'LANGGRAPH_CHECKPOINTER_MODE',
  ]) {
    if (String(env[name] || '').trim()) fail('PRODUCTION_CUTOVER_CONFIGURATION_FORBIDDEN');
  }
  return Object.freeze({ verified: true });
}

async function run(env = process.env, dependencies = {}) {
  assert005oCloudEnvironment(env);
  const result = await runBailianDependencyProbe({ env, ...dependencies });
  console.log(JSON.stringify({
    batch: '005o-bailian-model-monitor',
    status: 'PASS',
    applicationProbe: result.appProbe.status,
    applicationHttpStatus: result.appProbe.httpStatus,
    applicationLatencyMs: result.appProbe.latencyMs,
    genericProbe: result.genericProbe.status,
    genericHttpStatus: result.genericProbe.httpStatus,
    genericLatencyMs: result.genericProbe.latencyMs,
    accountStanding: result.accountStanding,
    credentialsValidated: result.credentialsValidated,
    appIdValidated: result.appIdValidated,
    timeoutMs: result.timeoutMs,
    responseContentEmitted: result.responseContentEmitted,
    productionUserStoreRemainsSqlite: true,
    postgresNetworkUsed: false,
  }));
}

if (require.main === module) {
  run().catch((error) => {
    console.log(JSON.stringify({
      batch: '005o-bailian-model-monitor',
      status: 'FAIL',
      errorCode: error?.code || 'BAILIAN_MONITOR_UNKNOWN_FAILURE',
      responseContentEmitted: false,
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  DEDICATED_CONFIRMATION,
  LIVE_PROBE_CONFIRMATION,
  VERIFY_CONFIRMATION,
  assert005oCloudEnvironment,
  run,
};
