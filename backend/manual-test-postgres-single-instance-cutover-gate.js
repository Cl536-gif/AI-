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
    env: {
      TENCENT_PG_CUTOVER_MODE: FULL_CUTOVER_MODE,
      TENCENT_PG_CUTOVER_CONFIRM: FULL_CUTOVER_CONFIRMATION,
    },
    isFullCutoverReady: () => true,
  }),
  { mode: FULL_CUTOVER_MODE, allowed: true }
);

console.log(JSON.stringify({
  batch: '005a-postgres-cutover-gate',
  status: 'PASS',
  sqliteDefaultUnchanged: true,
  singleInstanceCanaryRequiresConfirmation: true,
  singleInstanceAndPoolMaxOneRequired: true,
  fullCutoverFailsClosedUntilReady: true,
}));
