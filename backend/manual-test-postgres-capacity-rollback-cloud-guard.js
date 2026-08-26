const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONFIRMATION,
  DEDICATED_CONFIRMATION,
  assert005iCloudEnvironment,
} = require('./manual-test-postgres-capacity-rollback-cloud');

const validEnv = {
  RUN_005I_CAPACITY_VERIFY: CONFIRMATION,
  RUN_005I_DEDICATED_SERVICE: DEDICATED_CONFIRMATION,
  USER_STORE_ADAPTER: 'sqlite',
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
  TENCENT_PG_HOST: '10.0.0.8',
  TENCENT_PG_PORT: '5432',
};

function expectCode(env, code) {
  assert.throws(() => assert005iCloudEnvironment(env), (error) => error?.code === code);
}

const verified = assert005iCloudEnvironment(validEnv);
assert.strictEqual(verified.capacity.applicationConnectionLimit, 20);
assert.strictEqual(verified.rollbackPolicy.minSamples, 100);
expectCode({ ...validEnv, RUN_005I_CAPACITY_VERIFY: '' }, 'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005I_DEDICATED_SERVICE: '' }, 'DEDICATED_SERVICE_REQUIRED');
expectCode({ ...validEnv, USER_STORE_ADAPTER: 'tencent-postgres' }, 'SQLITE_PRODUCTION_PATH_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_HOST: 'db.example.com' }, 'PRIVATE_IPV4_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_PORT: '15432' }, 'POSTGRES_PORT_MUST_BE_5432');
expectCode(
  { ...validEnv, TENCENT_PG_OBSERVED_POOL_MAX: '4' },
  'POSTGRES_FULL_CAPACITY_TOPOLOGY_MISMATCH'
);
expectCode(
  { ...validEnv, RUN_005I_ROLLBACK_POLICY: '' },
  'POSTGRES_ROLLBACK_POLICY_CONFIRMATION_REQUIRED'
);

const preflight = fs.readFileSync(
  path.join(__dirname, 'sql/postgres/005i_capacity_preflight.review.sql'),
  'utf8'
);
assert(preflight.includes('SET TRANSACTION READ ONLY'));
assert(preflight.includes("current_setting('max_connections')"));
assert(preflight.includes('current_database_connections'));
assert(preflight.includes('waiting_application_connections'));
assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(
  preflight.replace(/^--.*$/gm, '')
));

console.log(JSON.stringify({
  batch: '005i-capacity-rollback-cloud',
  check: 'local_cloud_guard',
  status: 'PASS',
  dedicatedServiceRequired: true,
  productionUserStoreRemainsSqlite: true,
  observedTopologyRequired: true,
  capacityBudgetRequired: true,
  rollbackThresholdsRequired: true,
  privateNetworkRequired: true,
  dmsPreflightReadOnly: true,
  networkUsed: false,
}));
