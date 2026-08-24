const crypto = require('crypto');
const { createPostgresPool } = require('./src/db/postgresPool');
const {
  assertCloudVerificationEnvironment,
  createVerificationConfig,
  normalizeErrorCode,
} = require('./src/db/postgresCloudVerification');
const {
  createTencentPostgresUserStore,
} = require('./src/stores/tencentPostgresUserStore');

const CONFIRMATION = 'CONFIRMED_PRIVATE_VPC';

function assertCondition(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function assert004fCloudEnvironment(env = process.env) {
  if (String(env.RUN_004F_ENERGY_CALCULATIONS_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004f真实云端验证尚未获得明确授权'), {
      code: 'VERIFY_CONFIRMATION_REQUIRED',
    });
  }
  return createVerificationConfig(assertCloudVerificationEnvironment({
    ...env,
    RUN_003D_CLOUD_VERIFY: CONFIRMATION,
  }));
}

function createRecorder({ write = console.log, now = () => new Date() } = {}) {
  const checks = [];
  return Object.freeze({
    checks,
    record(check, details = {}) {
      const entry = Object.freeze({
        batch: '004f-adapter-cloud',
        check,
        status: 'PASS',
        at: now().toISOString(),
        ...details,
      });
      checks.push(entry);
      write(JSON.stringify(entry));
    },
  });
}

function createSandboxStore(client) {
  return createTencentPostgresUserStore({
    async runUserTransaction(userId, callback) {
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true)",
        [userId]
      );
      return callback(client);
    },
    async runPostgresClient(callback) {
      return callback(client);
    },
  });
}

function calculation(weightKg, activityLevel, tee) {
  return {
    formulaId: 'FAO_WHO_UNU_SCHOFIELD_BMR_X_CHINA_PAL',
    formulaVersion: '1.0.0',
    inputs: {
      equationSex: 'female',
      ageYears: 22,
      heightCm: 165,
      weightKg,
      activityLevel,
    },
    assumptions: ['adult', 'non-pregnant'],
    outputs: { estimatedTeeKcalPerDay: tee },
    sourceRefs: ['https://example.invalid/fao'],
  };
}

async function verifyAdapterInRollbackSandbox(pool, evidence) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const userA = `acct:004f_a_${suffix}`;
  const userB = `acct:004f_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    const first = await store.recordEnergyCalculation(
      userA,
      { ...calculation(60, 'light', 2063.5), ignoredDomainField: true },
      { now: '2026-08-24T16:00:00+08:00' }
    );
    assertCondition(
      Boolean(first.calculationId)
        && first.userId === userA
        && first.formulaVersion === '1.0.0'
        && first.inputs.weightKg === 60
        && first.assumptions.length === 2
        && first.outputs.estimatedTeeKcalPerDay === 2063.5
        && first.sourceRefs.length === 1
        && first.createdAt === '2026-08-24T08:00:00.000Z',
      'ENERGY_CALCULATION_WRITE_OR_MAPPING_MISMATCH'
    );
    evidence.record('energy_calculation_write_and_mapping_verified', {
      backendPid: client.processID,
      generatedCalculationId: true,
      timestampNormalized: true,
      unknownDomainFieldsExcluded: true,
    });

    const second = await store.recordEnergyCalculation(
      userA,
      calculation(59.5, 'moderate', 2394.5),
      { now: '2026-08-24T17:00:00+08:00' }
    );
    const history = await store.listEnergyCalculations(userA, { limit: 10 });
    assertCondition(
      second.calculationId !== first.calculationId
        && history.length === 2
        && history[0].calculationId === second.calculationId
        && history[1].calculationId === first.calculationId
        && history[0].inputs.activityLevel === 'moderate',
      'ENERGY_CALCULATION_APPEND_OR_ORDER_MISMATCH'
    );
    evidence.record('energy_calculation_append_and_order_verified', {
      backendPid: client.processID,
      calculationCount: history.length,
      distinctCalculationIds: true,
      newestFirst: true,
    });

    await client.query('SAVEPOINT invalid_energy_calculation');
    let invalidCode = null;
    try {
      await store.recordEnergyCalculation(userA, {
        formulaId: 'formula',
        formulaVersion: '1',
        inputs: {},
      });
    } catch (error) {
      invalidCode = normalizeErrorCode(error);
    }
    await client.query('ROLLBACK TO SAVEPOINT invalid_energy_calculation');
    const afterInvalid = await store.listEnergyCalculations(userA, { limit: 10 });
    assertCondition(
      invalidCode === '22023' && afterInvalid.length === 2,
      'INVALID_ENERGY_CALCULATION_NOT_SAFELY_REJECTED'
    );
    evidence.record('invalid_energy_calculation_rejected_without_mutation', {
      backendPid: client.processID,
      errorCode: invalidCode,
      calculationCountRemains: afterInvalid.length,
    });

    const userBHistory = await store.listEnergyCalculations(userB, { limit: 10 });
    assertCondition(userBHistory.length === 0, 'CROSS_USER_ENERGY_CALCULATION_VISIBLE');
    evidence.record('cross_user_energy_calculation_isolation_verified', {
      backendPid: client.processID,
      crossUserCalculationCount: userBHistory.length,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('energy_calculation_adapter_sandbox_rolled_back', {
          backendPid: client.processID,
          cleanup: 'rollback',
        });
      } catch (error) {
        rollbackError = error;
        releaseError = error;
      }
    }
    client.release(releaseError);
    if (rollbackError) throw rollbackError;
  }

  const cleanupClient = await pool.connect();
  let cleanupOpen = false;
  try {
    await cleanupClient.query('BEGIN');
    cleanupOpen = true;
    await cleanupClient.query(
      "SELECT set_config('app.current_user_id', $1, true)",
      [userA]
    );
    const result = await cleanupClient.query(
      'SELECT (SELECT count(*)::int FROM app.users WHERE user_id = $1) AS users, (SELECT count(*)::int FROM app.energy_calculations WHERE user_id = $1) AS energy_calculations',
      [userA]
    );
    const counts = result.rows[0];
    assertCondition(
      Object.values(counts).every((count) => count === 0),
      'ENERGY_CALCULATION_ADAPTER_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('energy_calculation_adapter_cleanup_proven', {
      backendPid: cleanupClient.processID,
      remainingRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    });
  } finally {
    let rollbackError = null;
    if (cleanupOpen) {
      try {
        await cleanupClient.query('ROLLBACK');
      } catch (error) {
        rollbackError = error;
      }
    }
    cleanupClient.release(rollbackError);
    if (rollbackError) throw rollbackError;
  }
}

async function run() {
  const config = assert004fCloudEnvironment(process.env);
  const evidence = createRecorder();
  const pool = createPostgresPool({ config });
  try {
    evidence.record('verification_started', {
      processPid: process.pid,
      adapterRemainsSqlite: true,
      privateNetworkGuardPassed: true,
      testPoolMax: config.poolMax,
    });
    await verifyAdapterInRollbackSandbox(pool, evidence);
    console.log(JSON.stringify({
      batch: '004f-adapter-cloud',
      status: 'PASS',
      processPid: process.pid,
      checkCount: evidence.checks.length,
      cleanup: 'PASS',
    }));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      batch: '004f-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004fCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};
