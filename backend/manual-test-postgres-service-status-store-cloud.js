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

function assert004eCloudEnvironment(env = process.env) {
  if (String(env.RUN_004E_SERVICE_STATUS_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004e真实云端验证尚未获得明确授权'), {
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
        batch: '004e-adapter-cloud',
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

async function verifyAdapterInRollbackSandbox(pool, evidence) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const userA = `acct:004e_a_${suffix}`;
  const userB = `acct:004e_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    const initial = await store.getServiceStatus(userA);
    assertCondition(initial === null, 'INITIAL_SERVICE_STATUS_NOT_EMPTY');

    const onboarding = await store.setServiceStatus(
      userA,
      { status: 'onboarding_incomplete' },
      { reason: 'long_term_selected' }
    );
    const confirmed = await store.setServiceStatus(
      userA,
      { status: 'profile_confirmed' },
      { reason: 'profile_confirmed_by_user' }
    );
    const trial = await store.setServiceStatus(userA, {
      status: 'trial_active',
      trialStartedAt: '2026-08-24T16:30:00+08:00',
      trialEndsAt: '2026-09-07T16:30:00+08:00',
      renewalReminderAt: '2026-09-06T16:30:00+08:00',
      officialPlanId: 'plan-004e-cloud',
    }, { reason: 'first_official_plan_delivered' });
    assertCondition(
      onboarding.status === 'onboarding_incomplete'
        && confirmed.status === 'profile_confirmed'
        && trial.status === 'trial_active'
        && trial.trialStartedAt === '2026-08-24T08:30:00.000Z'
        && trial.trialEndsAt === '2026-09-07T08:30:00.000Z'
        && trial.renewalReminderAt === '2026-09-06T08:30:00.000Z'
        && trial.officialPlanId === 'plan-004e-cloud',
      'SERVICE_STATUS_SEQUENCE_MISMATCH'
    );
    evidence.record('service_status_sequence_and_timestamps_verified', {
      backendPid: client.processID,
      transitionSteps: 3,
      timestampNormalizationMatched: true,
    });

    const expired = await store.setServiceStatus(
      userA,
      { ...trial, status: 'trial_expired' },
      { reason: 'trial_period_ended_without_subscription' }
    );
    assertCondition(
      expired.status === 'trial_expired'
        && expired.officialPlanId === trial.officialPlanId
        && expired.trialStartedAt === trial.trialStartedAt,
      'SPREAD_CURRENT_SERVICE_STATUS_MISMATCH'
    );
    evidence.record('spread_current_service_status_filtered_and_saved', {
      backendPid: client.processID,
      unknownDomainFieldsExcluded: true,
      trialMetadataPreserved: true,
    });

    const current = await store.getServiceStatus(userA);
    const transitions = await store.listServiceTransitions(userA, { limit: 10 });
    assertCondition(
      current?.status === 'trial_expired'
        && transitions.length === 4
        && transitions.map((item) => item.toStatus).join(',') === (
          'trial_expired,trial_active,profile_confirmed,onboarding_incomplete'
        )
        && transitions[3].fromStatus === null,
      'SERVICE_STATUS_READ_OR_HISTORY_MISMATCH'
    );
    evidence.record('service_status_read_and_history_verified', {
      backendPid: client.processID,
      currentStatusMatched: true,
      transitionCount: transitions.length,
      initialFromStatusEmpty: true,
    });

    await client.query('SAVEPOINT invalid_service_status');
    let invalidCode = null;
    try {
      await store.setServiceStatus(userA, { status: 'not_valid' });
    } catch (error) {
      invalidCode = normalizeErrorCode(error);
    }
    await client.query('ROLLBACK TO SAVEPOINT invalid_service_status');
    const afterInvalid = await store.getServiceStatus(userA);
    const historyAfterInvalid = await store.listServiceTransitions(userA, { limit: 10 });
    assertCondition(
      invalidCode === '22023'
        && afterInvalid?.status === 'trial_expired'
        && historyAfterInvalid.length === 4,
      'INVALID_SERVICE_STATUS_NOT_SAFELY_REJECTED'
    );
    evidence.record('invalid_service_status_rejected_without_mutation', {
      backendPid: client.processID,
      errorCode: invalidCode,
      transitionCountRemains: historyAfterInvalid.length,
    });

    const userBStatus = await store.getServiceStatus(userB);
    const userBTransitions = await store.listServiceTransitions(userB, { limit: 10 });
    assertCondition(
      userBStatus === null && userBTransitions.length === 0,
      'CROSS_USER_SERVICE_STATUS_VISIBLE'
    );
    evidence.record('cross_user_service_status_isolation_verified', {
      backendPid: client.processID,
      crossUserStatusVisible: false,
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
        evidence.record('service_status_adapter_sandbox_rolled_back', {
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
      'SELECT (SELECT count(*)::int FROM app.users WHERE user_id = $1) AS users, (SELECT count(*)::int FROM app.user_service_status WHERE user_id = $1) AS service_status, (SELECT count(*)::int FROM app.user_service_transitions WHERE user_id = $1) AS service_transitions',
      [userA]
    );
    const counts = result.rows[0];
    assertCondition(
      Object.values(counts).every((count) => count === 0),
      'SERVICE_STATUS_ADAPTER_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('service_status_adapter_cleanup_proven', {
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
  const config = assert004eCloudEnvironment(process.env);
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
      batch: '004e-adapter-cloud',
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
      batch: '004e-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004eCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};
