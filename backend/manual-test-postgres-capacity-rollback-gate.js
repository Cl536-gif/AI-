const assert = require('assert');
const {
  CAPACITY_REVIEW_CONFIRMATION,
  assertFullPostgresCapacityAllowed,
} = require('./src/db/postgresCapacityGate');
const {
  ROLLBACK_POLICY_CONFIRMATION,
  createPostgresOperationalSnapshot,
  evaluatePostgresRollbackSignals,
  parsePostgresRollbackPolicy,
} = require('./src/db/postgresRollbackSignals');

const env = {
  RUN_005I_CAPACITY_REVIEW: CAPACITY_REVIEW_CONFIRMATION,
  TENCENT_PG_FULL_MAX_INSTANCES: '4',
  TENCENT_PG_POOL_MAX: '5',
  TENCENT_PG_OBSERVED_MAX_INSTANCES: '4',
  TENCENT_PG_OBSERVED_POOL_MAX: '5',
  TENCENT_PG_DATABASE_MAX_CONNECTIONS: '100',
  TENCENT_PG_OPERATIONAL_RESERVE_CONNECTIONS: '20',
  TENCENT_PG_FULL_CONNECTION_BUDGET: '60',
  RUN_005I_ROLLBACK_POLICY: ROLLBACK_POLICY_CONFIRMATION,
  TENCENT_PG_ROLLBACK_MIN_SAMPLES: '100',
  TENCENT_PG_ROLLBACK_POOL_SATURATION_PCT: '90',
  TENCENT_PG_ROLLBACK_WAITING_CLIENTS: '2',
  TENCENT_PG_ROLLBACK_READINESS_FAILURES: '3',
  TENCENT_PG_ROLLBACK_CONNECTION_TIMEOUT_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_TRANSACTION_FAILURE_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_HTTP_SIDE_EFFECT_FAILURE_RATE_PCT: '5',
  TENCENT_PG_ROLLBACK_IDENTITY_FAILURE_RATE_PCT: '5',
};

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

const capacity = assertFullPostgresCapacityAllowed({ env });
assert.strictEqual(capacity.applicationConnectionLimit, 20);
assert.strictEqual(capacity.applicationHeadroom, 40);
assert.strictEqual(capacity.databaseHeadroom, 60);
expectCode(
  () => assertFullPostgresCapacityAllowed({ env: { ...env, RUN_005I_CAPACITY_REVIEW: '' } }),
  'POSTGRES_FULL_CAPACITY_CONFIRMATION_REQUIRED'
);
expectCode(
  () => assertFullPostgresCapacityAllowed({
    env: { ...env, TENCENT_PG_OBSERVED_MAX_INSTANCES: '3' },
  }),
  'POSTGRES_FULL_CAPACITY_TOPOLOGY_MISMATCH'
);
expectCode(
  () => assertFullPostgresCapacityAllowed({
    env: { ...env, TENCENT_PG_FULL_CONNECTION_BUDGET: '19' },
  }),
  'POSTGRES_FULL_CAPACITY_BUDGET_EXCEEDED'
);
expectCode(
  () => assertFullPostgresCapacityAllowed({
    env: {
      ...env,
      TENCENT_PG_DATABASE_MAX_CONNECTIONS: '30',
      TENCENT_PG_OPERATIONAL_RESERVE_CONNECTIONS: '20',
    },
  }),
  'POSTGRES_FULL_CAPACITY_BUDGET_EXCEEDED'
);

const policy = parsePostgresRollbackPolicy(env);
expectCode(
  () => parsePostgresRollbackPolicy({ ...env, RUN_005I_ROLLBACK_POLICY: '' }),
  'POSTGRES_ROLLBACK_POLICY_CONFIRMATION_REQUIRED'
);

const healthy = createPostgresOperationalSnapshot({
  pool: { totalCount: 3, idleCount: 2, waitingCount: 0 },
  poolMax: 5,
  counters: { sampleCount: 100 },
});
assert.strictEqual(evaluatePostgresRollbackSignals(healthy, policy).action, 'continue');

const insufficient = createPostgresOperationalSnapshot({
  pool: { totalCount: 1, idleCount: 1, waitingCount: 0 },
  poolMax: 5,
  counters: { sampleCount: 99 },
});
assert.deepStrictEqual(evaluatePostgresRollbackSignals(insufficient, policy), {
  action: 'hold',
  shouldRollback: false,
  reasons: ['INSUFFICIENT_SAMPLES'],
});

const waiting = createPostgresOperationalSnapshot({
  pool: { totalCount: 5, idleCount: 0, waitingCount: 2 },
  poolMax: 5,
  counters: { sampleCount: 1 },
});
assert(evaluatePostgresRollbackSignals(waiting, policy).reasons.includes('POOL_WAITING_CLIENTS'));
assert(evaluatePostgresRollbackSignals(waiting, policy).reasons.includes('POOL_SATURATION'));

const failures = createPostgresOperationalSnapshot({
  pool: { totalCount: 2, idleCount: 2, waitingCount: 0 },
  poolMax: 5,
  counters: {
    sampleCount: 100,
    readinessConsecutiveFailures: 3,
    connectionTimeoutCount: 5,
    transactionFailureCount: 5,
    httpSideEffectFailureCount: 5,
    identityFailureCount: 5,
  },
});
const rollback = evaluatePostgresRollbackSignals(failures, policy);
assert.strictEqual(rollback.action, 'rollback');
assert.strictEqual(rollback.shouldRollback, true);
assert.deepStrictEqual(rollback.reasons, [
  'READINESS_FAILURES',
  'CONNECTION_TIMEOUT_RATE',
  'TRANSACTION_FAILURE_RATE',
  'HTTP_SIDE_EFFECT_FAILURE_RATE',
  'IDENTITY_FAILURE_RATE',
]);

console.log(JSON.stringify({
  batch: '005i-capacity-rollback-gate',
  status: 'PASS',
  applicationConnectionLimit: capacity.applicationConnectionLimit,
  applicationHeadroom: capacity.applicationHeadroom,
  databaseHeadroom: capacity.databaseHeadroom,
  topologyMismatchRejected: true,
  oversubscriptionRejected: true,
  insufficientSamplesHold: true,
  hardPoolSignalsRollback: true,
  rateSignalsRollback: true,
  fullCutoverOpened: false,
}));
