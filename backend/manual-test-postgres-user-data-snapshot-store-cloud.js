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

function assert004lCloudEnvironment(env = process.env) {
  if (String(env.RUN_004L_USER_DATA_SNAPSHOT_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004l真实云端验证尚未获得明确授权'), {
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
        batch: '004l-snapshot-cloud',
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

function assertEmptySnapshot(snapshot, userId, code) {
  assertCondition(
    snapshot.userId === userId
      && snapshot.profile === null
      && snapshot.profileRevisions.length === 0
      && snapshot.serviceStatus === null
      && snapshot.adviceHistory.length === 0
      && snapshot.events.length === 0
      && snapshot.energyCalculations.length === 0
      && snapshot.plans.length === 0
      && snapshot.serviceTransitions.length === 0,
    code
  );
}

async function verifySnapshotInRollbackSandbox(pool, evidence) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const userA = `acct:004l_a_${suffix}`;
  const userB = `acct:004l_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    await store.updateProfile(userA, {
      body: {
        equationSex: 'female',
        ageYears: 22,
        heightCm: 165,
        currentWeightKg: 60,
      },
      diet: {
        scene: 'cafeteria',
        goals: ['004l snapshot verification'],
      },
    }, { source: 'system', expectedVersion: 0 });
    await store.setServiceStatus(userA, {
      status: 'profile_confirmed',
    }, { reason: '004l_snapshot_fixture' });
    await store.recordAdvice(userA, {
      content: '004l沙箱建议',
      metadata: { source: 'cloud-sandbox' },
      idempotencyKey: `004l-advice-${suffix}`,
      createdAt: '2026-08-25T08:00:00.000Z',
    });
    await store.appendEvent({
      userId: userA,
      eventType: 'meal',
      occurredAt: '2026-08-25T08:05:00.000Z',
      recordedAt: '2026-08-25T08:05:00.000Z',
      payload: { summary: '004l sandbox meal' },
      source: 'user',
      idempotencyKey: `004l-event-${suffix}`,
    });
    const calculation = await store.recordEnergyCalculation(userA, {
      formulaId: '004l_snapshot_formula',
      formulaVersion: '1.0.0',
      inputs: { weightKg: 60 },
      assumptions: [],
      outputs: { estimatedTeeKcalPerDay: 2000 },
      sourceRefs: [],
    }, { now: '2026-08-25T08:10:00.000Z' });
    await store.createPlanDraft(userA, {
      calculationId: calculation.calculationId,
      plan: { label: '004l snapshot plan' },
      changeReason: '004l_snapshot_fixture',
    }, { now: '2026-08-25T08:15:00.000Z' });
    evidence.record('snapshot_fixture_created', {
      backendPid: client.processID,
      fixtureSections: 8,
    });

    const snapshot = await store.getUserDataSnapshot(userA);
    assertCondition(
      snapshot.userId === userA
        && snapshot.profile?.profileVersion === 1
        && snapshot.profileRevisions.length === 1
        && snapshot.serviceStatus?.status === 'profile_confirmed'
        && snapshot.adviceHistory.length === 1
        && snapshot.events.length === 1
        && snapshot.energyCalculations.length === 1
        && snapshot.plans.length === 1
        && snapshot.serviceTransitions.length === 1,
      'USER_DATA_SNAPSHOT_SECTION_OR_COUNT_MISMATCH'
    );
    evidence.record('snapshot_sections_and_counts_verified', {
      backendPid: client.processID,
      sectionCount: 8,
      expectedCountsMatched: true,
    });

    assertCondition(
      snapshot.profile.profile.body.currentWeightKg === 60
        && snapshot.adviceHistory[0].metadata.source === 'cloud-sandbox'
        && snapshot.events[0].payload.summary === '004l sandbox meal'
        && snapshot.energyCalculations[0].createdAt === '2026-08-25T08:10:00.000Z'
        && snapshot.plans[0].plan.label === '004l snapshot plan',
      'USER_DATA_SNAPSHOT_MAPPING_MISMATCH'
    );
    evidence.record('snapshot_field_mapping_verified', {
      backendPid: client.processID,
      timestampsNormalized: true,
      jsonSnapshotsMapped: true,
    });

    const userBSnapshot = await store.getUserDataSnapshot(userB);
    assertEmptySnapshot(
      userBSnapshot,
      userB,
      'CROSS_USER_DATA_VISIBLE_IN_SNAPSHOT'
    );
    evidence.record('cross_user_snapshot_isolation_verified', {
      backendPid: client.processID,
      crossUserRowsVisible: 0,
    });

    const repeated = await store.getUserDataSnapshot(userA);
    assertCondition(
      repeated.profile.profileVersion === snapshot.profile.profileVersion
        && repeated.adviceHistory[0].adviceId === snapshot.adviceHistory[0].adviceId
        && repeated.events[0].eventId === snapshot.events[0].eventId
        && repeated.plans[0].planId === snapshot.plans[0].planId,
      'REPEATED_USER_DATA_SNAPSHOT_MISMATCH'
    );
    evidence.record('repeated_snapshot_read_verified', {
      backendPid: client.processID,
      stableIdentifiers: true,
      singleConnectionCompatible: true,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('user_data_snapshot_sandbox_rolled_back', {
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
  let cleanupError = null;
  try {
    await cleanupClient.query('BEGIN');
    cleanupOpen = true;
    const store = createSandboxStore(cleanupClient);
    assertEmptySnapshot(
      await store.getUserDataSnapshot(userA),
      userA,
      'USER_DATA_SNAPSHOT_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    assertEmptySnapshot(
      await store.getUserDataSnapshot(userB),
      userB,
      'CROSS_USER_SNAPSHOT_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('user_data_snapshot_cleanup_proven', {
      backendPid: cleanupClient.processID,
      remainingSandboxRows: 0,
    });
  } catch (error) {
    cleanupError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (cleanupOpen) {
      try {
        await cleanupClient.query('ROLLBACK');
      } catch (error) {
        rollbackError = error;
        cleanupError = error;
      }
    }
    cleanupClient.release(cleanupError);
    if (rollbackError) throw rollbackError;
  }
}

async function run() {
  const config = assert004lCloudEnvironment(process.env);
  const evidence = createRecorder();
  const pool = createPostgresPool({ config });
  try {
    evidence.record('verification_started', {
      processPid: process.pid,
      adapterRemainsSqlite: true,
      privateNetworkGuardPassed: true,
      testPoolMax: config.poolMax,
    });
    await verifySnapshotInRollbackSandbox(pool, evidence);
    console.log(JSON.stringify({
      batch: '004l-snapshot-cloud',
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
      batch: '004l-snapshot-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004lCloudEnvironment,
  createRecorder,
  run,
  verifySnapshotInRollbackSandbox,
};
