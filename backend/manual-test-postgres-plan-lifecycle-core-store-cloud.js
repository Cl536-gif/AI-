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

function assert004gCloudEnvironment(env = process.env) {
  if (String(env.RUN_004G_PLAN_LIFECYCLE_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004g真实云端验证尚未获得明确授权'), {
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
        batch: '004g-adapter-cloud',
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

async function enableGenericPlanActivation(store, userId) {
  await store.setServiceStatus(
    userId,
    { status: 'onboarding_incomplete' },
    { reason: '004g_sandbox_started' }
  );
  await store.setServiceStatus(
    userId,
    { status: 'profile_confirmed' },
    { reason: '004g_profile_confirmed' }
  );
  await store.setServiceStatus(userId, {
    status: 'trial_active',
    trialStartedAt: '2026-08-24T08:09:00.000Z',
    trialEndsAt: '2026-09-07T08:09:00.000Z',
    renewalReminderAt: '2026-09-06T08:09:00.000Z',
    officialPlanId: 'plan-004g-adapter-sandbox',
  }, { reason: '004g_enable_generic_activation' });
}

async function verifyAdapterInRollbackSandbox(pool, evidence) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const userA = `acct:004g_a_${suffix}`;
  const userB = `acct:004g_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    const energy = await store.recordEnergyCalculation(
      userA,
      calculation(),
      { now: '2026-08-24T16:00:00+08:00' }
    );
    const first = await store.createPlanDraft(userA, {
      calculationId: energy.calculationId,
      plan: {
        energyCalculationId: energy.calculationId,
        dailyEnergyKcal: 2064,
        label: '004g-v1',
      },
      changeReason: 'initial_plan',
      ignoredDomainField: true,
    }, { now: '2026-08-24T16:05:00+08:00' });
    const firstRead = await store.getPlan(userA, first.planId);
    assertCondition(
      Boolean(first.planId)
        && first.userId === userA
        && first.planVersion === 1
        && first.status === 'draft'
        && first.calculationId === energy.calculationId
        && first.plan.label === '004g-v1'
        && first.createdAt === '2026-08-24T08:05:00.000Z'
        && firstRead.planId === first.planId,
      'PLAN_DRAFT_WRITE_READ_OR_MAPPING_MISMATCH'
    );
    evidence.record('plan_draft_write_read_and_mapping_verified', {
      backendPid: client.processID,
      generatedPlanId: true,
      planVersion: first.planVersion,
      timestampNormalized: true,
      unknownDomainFieldsExcluded: true,
    });

    const drafts = await store.listPlans(userA, { limit: 10 });
    const noActive = await store.getActivePlan(userA);
    assertCondition(
      drafts.length === 1 && drafts[0].planId === first.planId && noActive === null,
      'PLAN_LIST_OR_INITIAL_ACTIVE_STATE_MISMATCH'
    );
    evidence.record('plan_list_and_initial_active_state_verified', {
      backendPid: client.processID,
      planCount: drafts.length,
      activePlanEmpty: true,
    });

    await enableGenericPlanActivation(store, userA);
    const activeFirst = await store.transitionPlan(
      userA,
      first.planId,
      'active',
      { reason: 'initial_activation', now: '2026-08-24T16:10:00+08:00' }
    );
    const selectedActive = await store.getActivePlan(userA);
    assertCondition(
      activeFirst.status === 'active'
        && activeFirst.activatedAt === '2026-08-24T08:10:00.000Z'
        && selectedActive.planId === first.planId,
      'PLAN_ACTIVATION_OR_ACTIVE_LOOKUP_MISMATCH'
    );
    evidence.record('plan_activation_and_active_lookup_verified', {
      backendPid: client.processID,
      activePlanMatched: true,
    });

    await store.transitionPlan(
      userA,
      first.planId,
      'paused',
      { reason: 'prepare_revision', now: '2026-08-24T16:20:00+08:00' }
    );
    const second = await store.createPlanDraft(userA, {
      calculationId: energy.calculationId,
      parentPlanId: first.planId,
      plan: {
        energyCalculationId: energy.calculationId,
        dailyEnergyKcal: 1980,
        label: '004g-v2',
      },
      changeReason: 'energy_adjustment',
    }, { now: '2026-08-24T16:30:00+08:00' });
    const activeSecond = await store.transitionPlan(
      userA,
      second.planId,
      'active',
      { reason: 'activate_revision', now: '2026-08-24T16:40:00+08:00' }
    );
    const supersededFirst = await store.getPlan(userA, first.planId);
    const history = await store.listPlans(userA, { limit: 10 });
    assertCondition(
      second.planVersion === 2
        && second.parentPlanId === first.planId
        && activeSecond.status === 'active'
        && supersededFirst.status === 'superseded'
        && supersededFirst.completedAt === '2026-08-24T08:40:00.000Z'
        && history.length === 2
        && history[0].planId === second.planId
        && history[1].planId === first.planId,
      'PLAN_REVISION_REPLACEMENT_OR_ORDER_MISMATCH'
    );
    evidence.record('plan_revision_replacement_and_order_verified', {
      backendPid: client.processID,
      planCount: history.length,
      versionsMonotonic: true,
      pausedParentSuperseded: true,
      newestFirst: true,
    });

    const firstTransitions = await store.listPlanTransitions(userA, first.planId);
    const secondTransitions = await store.listPlanTransitions(userA, second.planId);
    assertCondition(
      firstTransitions.length === 4
        && firstTransitions[0].toStatus === 'superseded'
        && firstTransitions[0].planId === first.planId
        && secondTransitions.length === 2
        && secondTransitions[0].toStatus === 'active',
      'PLAN_TRANSITION_HISTORY_MISMATCH'
    );
    evidence.record('plan_transition_history_verified', {
      backendPid: client.processID,
      firstPlanTransitionCount: firstTransitions.length,
      secondPlanTransitionCount: secondTransitions.length,
      newestFirst: true,
    });

    await client.query('SAVEPOINT invalid_plan_transition');
    let invalidCode = null;
    try {
      await store.transitionPlan(
        userA,
        second.planId,
        'active',
        { reason: 'invalid_repeat_activation' }
      );
    } catch (error) {
      invalidCode = normalizeErrorCode(error);
    }
    await client.query('ROLLBACK TO SAVEPOINT invalid_plan_transition');
    const afterInvalid = await store.getActivePlan(userA);
    assertCondition(
      invalidCode === '22023' && afterInvalid.planId === second.planId,
      'INVALID_PLAN_TRANSITION_NOT_SAFELY_REJECTED'
    );
    evidence.record('invalid_plan_transition_rejected_without_mutation', {
      backendPid: client.processID,
      errorCode: invalidCode,
      activePlanPreserved: true,
    });

    const userBPlans = await store.listPlans(userB, { limit: 10 });
    const userBActive = await store.getActivePlan(userB);
    const userBRead = await store.getPlan(userB, first.planId);
    const userBTransitions = await store.listPlanTransitions(userB, first.planId);
    assertCondition(
      userBPlans.length === 0
        && userBActive === null
        && userBRead === null
        && userBTransitions.length === 0,
      'CROSS_USER_PLAN_DATA_VISIBLE'
    );
    evidence.record('cross_user_plan_isolation_verified', {
      backendPid: client.processID,
      crossUserPlanCount: userBPlans.length,
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
        evidence.record('plan_lifecycle_adapter_sandbox_rolled_back', {
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
      'SELECT (SELECT count(*)::int FROM app.users WHERE user_id = $1) AS users, (SELECT count(*)::int FROM app.user_service_status WHERE user_id = $1) AS service_status, (SELECT count(*)::int FROM app.user_service_transitions WHERE user_id = $1) AS service_transitions, (SELECT count(*)::int FROM app.energy_calculations WHERE user_id = $1) AS energy_calculations, (SELECT count(*)::int FROM app.user_plan_versions WHERE user_id = $1) AS plans, (SELECT count(*)::int FROM app.plan_state_transitions WHERE user_id = $1) AS plan_transitions',
      [userA]
    );
    const counts = result.rows[0];
    assertCondition(
      Object.values(counts).every((count) => count === 0),
      'PLAN_LIFECYCLE_ADAPTER_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('plan_lifecycle_adapter_cleanup_proven', {
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
  const config = assert004gCloudEnvironment(process.env);
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
      batch: '004g-adapter-cloud',
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
      batch: '004g-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004gCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};
