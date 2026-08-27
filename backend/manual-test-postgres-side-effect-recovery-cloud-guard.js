const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONFIRMATION,
  DEDICATED_CONFIRMATION,
  assert005mSideEffectRecoveryEnvironment,
} = require('./manual-test-postgres-side-effect-recovery-cloud');
const {
  SIDE_EFFECT_FAULT_CONFIRMATION,
} = require('./src/langgraph/httpCanaryBoundary');

const validEnv = {
  RUN_005M_SIDE_EFFECT_RECOVERY_VERIFY: CONFIRMATION,
  RUN_005M_DEDICATED_SERVICE: DEDICATED_CONFIRMATION,
  RUN_005M_SIDE_EFFECT_FAULT_INJECTION: SIDE_EFFECT_FAULT_CONFIRMATION,
  LANGGRAPH_SIDE_EFFECT_RECOVERY_RUN_ID: '005m-local-guard-01',
  LANGGRAPH_HTTP_CANARY_TOKEN: 'test-only-http-token-at-least-32-characters',
  USER_STORE_ADAPTER: 'tencent-postgres',
  TENCENT_PG_CUTOVER_MODE: 'dual_instance_http_canary',
  TENCENT_PG_CUTOVER_CONFIRM: 'postgres-dual-instance-http-canary',
  RUN_005H_DEDICATED_SERVICE: 'CONFIRMED_005H_DEDICATED_HTTP_CANARY_SERVICE',
  TENCENT_PG_HTTP_CANARY_MAX_INSTANCES: '2',
  TENCENT_PG_POOL_MAX: '2',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'postgres',
  LANGGRAPH_CHECKPOINTER_CONFIRM: 'postgres-shared-checkpointer',
  LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION: '1.0.4',
  LANGGRAPH_CHECKPOINTER_MODE: 'dual_instance_http_canary',
  LANGGRAPH_CHECKPOINTER_MAX_INSTANCES: '2',
  LANGGRAPH_THREAD_LOCK_CONFIRM: 'postgres-thread-lock-http-canary',
  LANGGRAPH_THREAD_HMAC_SECRET: 'test-only-thread-secret-at-least-32-characters',
  HOSTNAME: '005m-local-pod-a',
  PORT: '3001',
  TENCENT_PG_HOST: '10.0.0.8',
  TENCENT_PG_PORT: '5432',
  TENCENT_PG_DATABASE: 'diet_secretary',
  TENCENT_PG_USER: 'diet_app',
  TENCENT_PG_PASSWORD: 'test-only-password',
  TENCENT_PG_SSL_MODE: 'disable',
};

function expectCode(env, phase, code) {
  assert.throws(
    () => assert005mSideEffectRecoveryEnvironment(env, phase),
    (error) => error?.code === code
  );
}

const verified = assert005mSideEffectRecoveryEnvironment(validEnv, 'fault');
assert.strictEqual(verified.phase, 'fault');
assert.strictEqual(verified.instanceFingerprint.length, 64);
expectCode({ ...validEnv, RUN_005M_SIDE_EFFECT_RECOVERY_VERIFY: '' }, 'fault',
  'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005M_DEDICATED_SERVICE: '' }, 'fault',
  'DEDICATED_SERVICE_REQUIRED');
expectCode({ ...validEnv, RUN_005M_SIDE_EFFECT_FAULT_INJECTION: '' }, 'fault',
  'FAULT_INJECTION_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, USER_STORE_ADAPTER: 'sqlite' }, 'fault',
  'LANGGRAPH_HTTP_CANARY_POSTGRES_STORE_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_HTTP_CANARY_MAX_INSTANCES: '1' }, 'fault',
  'POSTGRES_HTTP_CANARY_SCOPE_INVALID');
expectCode(validEnv, 'unknown', 'VERIFY_PHASE_INVALID');

const routeSource = fs.readFileSync(
  path.join(__dirname, 'src/routes/chatLanggraph.js'),
  'utf8'
);
assert(routeSource.includes('recoverPendingGraphTurn'));
assert(routeSource.includes('persistAndAcknowledgeGraphTurn'));
assert(routeSource.includes('isRetryOfRecoveredTurn'));
assert(routeSource.includes('HTTP_CANARY_FAULT_AFTER_ADVICE_PERSISTENCE'));

console.log(JSON.stringify({
  batch: '005m-side-effect-recovery-cloud',
  check: 'local_cloud_guard',
  status: 'PASS',
  dedicatedServiceRequired: true,
  sharedPostgresUserStoreRequired: true,
  sharedPostgresCheckpointerRequired: true,
  dualInstanceTopologyRequired: true,
  controlledFaultSeparatelyConfirmed: true,
  pendingTurnRecoveryRequired: true,
  identicalRetryShortCircuitRequired: true,
  networkUsed: false,
}));
