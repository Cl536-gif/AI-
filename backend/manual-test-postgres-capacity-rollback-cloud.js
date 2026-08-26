const { createPostgresPool, closePostgresPool } = require('./src/db/postgresPool');
const { checkPostgresReadiness } = require('./src/db/postgresReadiness');
const {
  assertFullPostgresCapacityAllowed,
} = require('./src/db/postgresCapacityGate');
const {
  createPostgresOperationalSnapshot,
  evaluatePostgresRollbackSignals,
  parsePostgresRollbackPolicy,
} = require('./src/db/postgresRollbackSignals');
const {
  isPrivateIpv4,
  normalizeErrorCode,
} = require('./src/db/postgresCloudVerification');

const CONFIRMATION = 'CONFIRMED_005I_CAPACITY_ROLLBACK_CLOUD';
const DEDICATED_CONFIRMATION = 'CONFIRMED_005I_DEDICATED_CAPACITY_SERVICE';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function assert005iCloudEnvironment(env = process.env) {
  if (String(env.RUN_005I_CAPACITY_VERIFY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.RUN_005I_DEDICATED_SERVICE || '').trim() !== DEDICATED_CONFIRMATION) {
    fail('DEDICATED_SERVICE_REQUIRED');
  }
  if (String(env.USER_STORE_ADAPTER || 'sqlite').trim().toLowerCase() !== 'sqlite') {
    fail('SQLITE_PRODUCTION_PATH_REQUIRED');
  }
  if (!isPrivateIpv4(String(env.TENCENT_PG_HOST || '').trim())) {
    fail('PRIVATE_IPV4_REQUIRED');
  }
  if (String(env.TENCENT_PG_PORT || '').trim() !== '5432') {
    fail('POSTGRES_PORT_MUST_BE_5432');
  }
  return Object.freeze({
    capacity: assertFullPostgresCapacityAllowed({ env }),
    rollbackPolicy: parsePostgresRollbackPolicy(env),
  });
}

async function run(env = process.env) {
  const verified = assert005iCloudEnvironment(env);
  const pool = createPostgresPool({ env });
  try {
    await checkPostgresReadiness({ pool });
    const healthy = createPostgresOperationalSnapshot({
      pool,
      poolMax: verified.capacity.poolMax,
      counters: { sampleCount: verified.rollbackPolicy.minSamples },
    });
    const healthySignal = evaluatePostgresRollbackSignals(healthy, verified.rollbackPolicy);
    if (healthySignal.action !== 'continue') fail('HEALTHY_SIGNAL_NOT_CONTINUE');

    const syntheticRollback = createPostgresOperationalSnapshot({
      pool: {
        totalCount: verified.capacity.poolMax,
        idleCount: 0,
        waitingCount: verified.rollbackPolicy.waitingClients,
      },
      poolMax: verified.capacity.poolMax,
      counters: { sampleCount: verified.rollbackPolicy.minSamples },
    });
    const rollbackSignal = evaluatePostgresRollbackSignals(
      syntheticRollback,
      verified.rollbackPolicy
    );
    if (!rollbackSignal.shouldRollback) fail('ROLLBACK_SIGNAL_NOT_TRIGGERED');

    console.log(JSON.stringify({
      batch: '005i-capacity-rollback-cloud',
      status: 'PASS',
      applicationConnectionLimit: verified.capacity.applicationConnectionLimit,
      applicationConnectionBudget: verified.capacity.applicationConnectionBudget,
      operationalReserveConnections: verified.capacity.operationalReserveConnections,
      topologyMatched: true,
      readinessPassed: true,
      actualPoolWaiting: healthy.poolWaiting,
      healthySignal: healthySignal.action,
      syntheticRollbackSignal: rollbackSignal.action,
      productionUserStoreRemainsSqlite: true,
      fullCutoverOpened: false,
    }));
  } finally {
    await pool.end().catch(() => undefined);
    await closePostgresPool().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      batch: '005i-capacity-rollback-cloud',
      status: 'FAIL',
      errorCode: normalizeErrorCode(error, 'CONFIGURATION_ERROR'),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  DEDICATED_CONFIRMATION,
  assert005iCloudEnvironment,
  run,
};
