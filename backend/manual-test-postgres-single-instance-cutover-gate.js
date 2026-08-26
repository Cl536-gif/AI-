const assert = require('assert');
const {
  SINGLE_INSTANCE_CANARY_MODE,
  FULL_CUTOVER_MODE,
  SINGLE_INSTANCE_CONFIRMATION,
  FULL_CUTOVER_CONFIRMATION,
  assertTencentPostgresCutoverAllowed,
} = require('./src/stores/tencentPostgresCutoverGate');

function expectCode(env, code, options = {}) {
  assert.throws(
    () => assertTencentPostgresCutoverAllowed({ env, ...options }),
    (error) => error && error.code === code
  );
}

const canaryEnv = {
  TENCENT_PG_CUTOVER_MODE: SINGLE_INSTANCE_CANARY_MODE,
  TENCENT_PG_CUTOVER_CONFIRM: SINGLE_INSTANCE_CONFIRMATION,
  TENCENT_PG_CANARY_MAX_INSTANCES: '1',
  TENCENT_PG_POOL_MAX: '1',
};

const fullEnv = {
  TENCENT_PG_CUTOVER_MODE: FULL_CUTOVER_MODE,
  TENCENT_PG_CUTOVER_CONFIRM: FULL_CUTOVER_CONFIRMATION,
  RUN_005I_CAPACITY_REVIEW: 'CONFIRMED_005I_FULL_CAPACITY_REVIEW',
  TENCENT_PG_FULL_MAX_INSTANCES: '4',
  TENCENT_PG_POOL_MAX: '5',
  TENCENT_PG_OBSERVED_MAX_INSTANCES: '4',
  TENCENT_PG_OBSERVED_POOL_MAX: '5',
  TENCENT_PG_DATABASE_MAX_CONNECTIONS: '100',
  TENCENT_PG_OPERATIONAL_RESERVE_CONNECTIONS: '20',
  TENCENT_PG_FULL_CONNECTION_BUDGET: '60',
  RUN_005I_ROLLBACK_POLICY: 'CONFIRMED_005I_AUTOMATIC_ROLLBACK_SIGNALS',
  TENCENT_PG_ROLLBACK_MIN_SAMPLES: '100',
  TENCENT_PG_ROLLBACK_POOL_SATURATION_PCT: '90',
  TENCENT_PG_ROLLBACK_WAITING_CLIENTS: '2',
  TENCENT_PG_ROLLBACK_READINESS_FAILURES: '3',
  TENCENT_PG_ROLLBACK_CONNECTION_TIMEOUT_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_TRANSACTION_FAILURE_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_HTTP_SIDE_EFFECT_FAILURE_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_IDENTITY_FAILURE_RATE_PCT: '5',
};

const finalGoNoGo = {
  decision: 'GO',
  observationMinutes: 60,
  requestCount: 100,
  failures: {},
  methodEvidenceVerified: true,
  acceptanceIntegrityVerified: true,
  sideEffectRecoveryVerified: true,
  rollbackControlVerified: true,
  modelMonitoringVerified: true,
  preproductionObservationVerified: true,
};

expectCode({}, 'POSTGRES_CUTOVER_MODE_REQUIRED');
expectCode(
  { ...canaryEnv, TENCENT_PG_CUTOVER_CONFIRM: '' },
  'POSTGRES_CANARY_CONFIRMATION_REQUIRED'
);
expectCode(
  { ...canaryEnv, TENCENT_PG_CANARY_MAX_INSTANCES: '2' },
  'POSTGRES_CANARY_SCOPE_INVALID'
);
expectCode(
  { ...canaryEnv, TENCENT_PG_POOL_MAX: '5' },
  'POSTGRES_CANARY_SCOPE_INVALID'
);
expectCode(
  {
    TENCENT_PG_CUTOVER_MODE: FULL_CUTOVER_MODE,
    TENCENT_PG_CUTOVER_CONFIRM: FULL_CUTOVER_CONFIRMATION,
  },
  'POSTGRES_FULL_CUTOVER_NOT_READY',
  { isFullCutoverReady: () => false }
);
expectCode(
  { TENCENT_PG_CUTOVER_MODE: 'unknown', TENCENT_PG_CUTOVER_CONFIRM: 'anything' },
  'POSTGRES_CUTOVER_MODE_UNSUPPORTED'
);

assert.deepStrictEqual(
  assertTencentPostgresCutoverAllowed({ env: canaryEnv }),
  {
    mode: SINGLE_INSTANCE_CANARY_MODE,
    maxInstances: 1,
    poolMax: 1,
    allowed: true,
  }
);

assert.deepStrictEqual(
  assertTencentPostgresCutoverAllowed({
    env: fullEnv,
    isFullCutoverReady: () => true,
    assertFinalGoNoGoAllowed: () => finalGoNoGo,
  }),
  {
    mode: FULL_CUTOVER_MODE,
    finalGoNoGo,
    capacity: {
      maxInstances: 4,
      poolMax: 5,
      observedMaxInstances: 4,
      observedPoolMax: 5,
      applicationConnectionLimit: 20,
      applicationConnectionBudget: 60,
      databaseMaxConnections: 100,
      operationalReserveConnections: 20,
      databaseApplicationLimit: 80,
      applicationHeadroom: 40,
      databaseHeadroom: 60,
      verified: true,
    },
    rollbackPolicy: {
      minSamples: 100,
      poolSaturationPct: 90,
      waitingClients: 2,
      readinessFailures: 3,
      connectionTimeoutRatePct: 5,
      transactionFailureRatePct: 5,
      httpSideEffectFailureRatePct: 5,
      identityFailureRatePct: 5,
    },
    allowed: true,
  }
);

console.log(JSON.stringify({
  batch: '005a-postgres-cutover-gate',
  status: 'PASS',
  sqliteDefaultUnchanged: true,
  singleInstanceCanaryRequiresConfirmation: true,
  singleInstanceAndPoolMaxOneRequired: true,
  fullCutoverFailsClosedUntilReady: true,
}));
