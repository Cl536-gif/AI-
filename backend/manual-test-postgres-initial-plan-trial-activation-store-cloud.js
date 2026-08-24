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

function assert004hCloudEnvironment(env = process.env) {
  if (String(env.RUN_004H_INITIAL_PLAN_TRIAL_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004h真实云端验证尚未获得明确授权'), {
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
        batch: '004h-adapter-cloud',
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

function calculation() {
  return {
    formulaId: 'FAO_WHO_UNU_SCHOFIELD_BMR_X_CHINA_PAL',
    formulaVersion: '1.0.0',
    inputs: { equationSex: 'female', ageYears: 22 },
    assumptions: [],
    outputs: { estimatedTeeKcalPerDay: 2063.5 },
    sourceRefs: [],
  };
}

async function prepareDraft(store, userId, label, createdAt) {
  const energy = await store.recordEnergyCalculation(
    userId,
    calculation(),
    { now: new Date(new Date(createdAt).getTime() - 300000).toISOString() }
  );
  await store.setServiceStatus(
    userId,
    { status: 'onboarding_incomplete' },
    { reason: '004h_cloud_sandbox_started' }
  );
  await store.setServiceStatus(
    userId,
    { status: 'profile_confirmed' },
    { reason: '004h_cloud_profile_confirmed' }
  );
  return store.createPlanDraft(userId, {
    calculationId: energy.calculationId,
    plan: {
      energyCalculationId: energy.calculationId,
      dailyEnergyKcal: 2064,
      label,
    },
    changeReason: 'initial_plan',
  }, { now: createdAt });
}

async function verifyAdapterInRollbackSandbox(pool, evidence) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const userA = `acct:004h_a_${suffix}`;
  const userB = `acct:004h_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    const first = await prepareDraft(
      store,
      userA,
      '004h-cloud-valid',
      '2026-08-24T08:05:00.000Z'
    );
    const trial = {
      trialStartedAt: '2026-08-24T08:10:00.000Z',
      trialEndsAt: '2026-09-07T08:10:00.000Z',
      renewalReminderAt: '2026-09-06T08:10:00.000Z',
    };
    const activated = await store.activateInitialPlanAndTrial(
      userA,
      first.planId,
      trial
    );
    const service = await store.getServiceStatus(userA);
    assertCondition(
      activated.planId === first.planId
        && activated.status === 'active'
        && activated.activatedAt === trial.trialStartedAt
        && service.status === 'trial_active'
        && service.officialPlanId === first.planId
        && service.trialStartedAt === trial.trialStartedAt
        && service.trialEndsAt === trial.trialEndsAt
        && service.renewalReminderAt === trial.renewalReminderAt,
      'INITIAL_PLAN_TRIAL_ACTIVATION_OR_MAPPING_MISMATCH'
    );
    evidence.record('initial_plan_trial_atomic_activation_verified', {
      backendPid: client.processID,
      planActivated: true,
      trialActivated: true,
      officialPlanMatched: true,
      timestampsNormalized: true,
    });

    const planTransitionsBefore = await store.listPlanTransitions(userA, first.planId);
    const serviceTransitionsBefore = await store.listServiceTransitions(userA, { limit: 10 });
    const retried = await store.activateInitialPlanAndTrial(userA, first.planId, trial);
    const planTransitionsAfter = await store.listPlanTransitions(userA, first.planId);
    const serviceTransitionsAfter = await store.listServiceTransitions(userA, { limit: 10 });
    assertCondition(
      retried.status === 'active'
        && planTransitionsBefore.length === 2
        && serviceTransitionsBefore.length === 3
        && planTransitionsAfter.length === planTransitionsBefore.length
        && serviceTransitionsAfter.length === serviceTransitionsBefore.length,
      'INITIAL_PLAN_TRIAL_IDEMPOTENT_RETRY_MISMATCH'
    );
    evidence.record('initial_plan_trial_idempotent_retry_verified', {
      backendPid: client.processID,
      planTransitionCount: planTransitionsAfter.length,
      serviceTransitionCount: serviceTransitionsAfter.length,
      duplicateTransitionsCreated: false,
    });

    const invalidDraft = await prepareDraft(
      store,
      userB,
      '004h-cloud-invalid',
      '2026-08-24T09:05:00.000Z'
    );
    await client.query('SAVEPOINT invalid_initial_activation');
    let invalidCode = null;
    try {
      await store.activateInitialPlanAndTrial(userB, invalidDraft.planId, {
        trialStartedAt: '2026-08-24T09:04:00.000Z',
        trialEndsAt: '2026-09-07T09:04:00.000Z',
        renewalReminderAt: '2026-09-06T09:04:00.000Z',
      });
    } catch (error) {
      invalidCode = normalizeErrorCode(error);
    }
    await client.query('ROLLBACK TO SAVEPOINT invalid_initial_activation');
    const invalidPlanAfter = await store.getPlan(userB, invalidDraft.planId);
    const invalidServiceAfter = await store.getServiceStatus(userB);
    assertCondition(
      invalidCode === '22023'
        && invalidPlanAfter.status === 'draft'
        && invalidServiceAfter.status === 'profile_confirmed',
      'INVALID_INITIAL_ACTIVATION_NOT_SAFELY_REJECTED'
    );
    evidence.record('invalid_initial_activation_rejected_without_partial_write', {
      backendPid: client.processID,
      errorCode: invalidCode,
      planRemainsDraft: true,
      serviceRemainsProfileConfirmed: true,
    });

    const userBCannotReadA = await store.getPlan(userB, first.planId);
    const userBTransitions = await store.listPlanTransitions(userB, first.planId);
    assertCondition(
      userBCannotReadA === null && userBTransitions.length === 0,
      'CROSS_USER_INITIAL_PLAN_DATA_VISIBLE'
    );
    evidence.record('cross_user_initial_plan_isolation_verified', {
      backendPid: client.processID,
      crossUserPlanVisible: false,
      crossUserTransitionCount: userBTransitions.length,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('initial_plan_trial_adapter_sandbox_rolled_back', {
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
    const countsByUser = [];
    for (const sandboxUserId of [userA, userB]) {
      await cleanupClient.query(
        "SELECT set_config('app.current_user_id', $1, true)",
        [sandboxUserId]
      );
      const result = await cleanupClient.query(
        'SELECT (SELECT count(*)::int FROM app.users WHERE user_id = $1) AS users, (SELECT count(*)::int FROM app.user_service_status WHERE user_id = $1) AS service_status, (SELECT count(*)::int FROM app.user_service_transitions WHERE user_id = $1) AS service_transitions, (SELECT count(*)::int FROM app.energy_calculations WHERE user_id = $1) AS energy_calculations, (SELECT count(*)::int FROM app.user_plan_versions WHERE user_id = $1) AS plans, (SELECT count(*)::int FROM app.plan_state_transitions WHERE user_id = $1) AS plan_transitions',
        [sandboxUserId]
      );
      countsByUser.push(result.rows[0]);
    }
    const counts = countsByUser.flatMap((row) => Object.values(row));
    assertCondition(
      counts.every((count) => count === 0),
      'INITIAL_PLAN_TRIAL_ADAPTER_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('initial_plan_trial_adapter_cleanup_proven', {
      backendPid: cleanupClient.processID,
      remainingRows: counts.reduce((sum, count) => sum + count, 0),
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
  const config = assert004hCloudEnvironment(process.env);
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
      batch: '004h-adapter-cloud',
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
      batch: '004h-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004hCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};
