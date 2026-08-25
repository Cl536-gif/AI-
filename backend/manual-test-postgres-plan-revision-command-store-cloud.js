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

function assert004iCloudEnvironment(env = process.env) {
  if (String(env.RUN_004I_PLAN_REVISION_COMMAND_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004i真实云端验证尚未获得明确授权'), {
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
        batch: '004i-adapter-cloud',
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
  const userA = `acct:004i_a_${suffix}`;
  const userB = `acct:004i_b_${suffix}`;
  const commandId = `004i-command-${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    await store.setServiceStatus(
      userA,
      { status: 'subscribed' },
      { reason: '004i_adapter_sandbox_service' }
    );
    const planA = await store.createPlanDraft(userA, {
      plan: { label: '004i-adapter-a' },
      changeReason: '004i_adapter_revision',
    }, { now: '2026-08-25T04:00:00.000Z' });
    const draftCommand = await store.recordPlanRevisionCommand(userA, commandId, {
      planId: planA.planId,
      status: 'draft_created',
      now: '2026-08-25T04:01:00.000Z',
    });
    const selectedDraft = await store.getPlanRevisionCommand(userA, commandId);
    assertCondition(
      draftCommand.commandId === commandId
        && draftCommand.userId === userA
        && draftCommand.planId === planA.planId
        && draftCommand.status === 'draft_created'
        && selectedDraft.commandId === commandId
        && selectedDraft.createdAt === '2026-08-25T04:01:00.000Z',
      'PLAN_REVISION_COMMAND_DRAFT_WRITE_READ_OR_MAPPING_MISMATCH'
    );
    evidence.record('draft_command_write_read_and_mapping_verified', {
      backendPid: client.processID,
      commandMatched: true,
      planMatched: true,
      timestampsNormalized: true,
    });

    const retriedDraft = await store.recordPlanRevisionCommand(userA, commandId, {
      planId: planA.planId,
      status: 'draft_created',
      now: '2026-08-25T04:02:00.000Z',
    });
    assertCondition(
      retriedDraft.commandId === commandId
        && retriedDraft.planId === planA.planId
        && retriedDraft.createdAt === draftCommand.createdAt
        && retriedDraft.updatedAt === '2026-08-25T04:02:00.000Z',
      'PLAN_REVISION_COMMAND_IDEMPOTENT_RETRY_MISMATCH'
    );
    evidence.record('draft_command_idempotent_retry_verified', {
      backendPid: client.processID,
      createdAtPreserved: true,
      updatedAtAdvanced: true,
    });

    await store.transitionPlan(userA, planA.planId, 'active', {
      reason: '004i_adapter_delivered',
      now: '2026-08-25T04:03:00.000Z',
    });
    const delivered = await store.recordPlanRevisionCommand(userA, commandId, {
      planId: planA.planId,
      status: 'delivered',
      now: '2026-08-25T04:04:00.000Z',
    });
    assertCondition(
      delivered.status === 'delivered'
        && delivered.createdAt === draftCommand.createdAt
        && delivered.updatedAt === '2026-08-25T04:04:00.000Z',
      'PLAN_REVISION_COMMAND_DELIVERY_ADVANCE_MISMATCH'
    );
    evidence.record('command_advanced_to_delivered_verified', {
      backendPid: client.processID,
      statusMonotonic: true,
      createdAtPreserved: true,
    });

    const crossUserRead = await store.getPlanRevisionCommand(userB, commandId);
    assertCondition(crossUserRead === null, 'CROSS_USER_PLAN_REVISION_COMMAND_VISIBLE');
    evidence.record('cross_user_command_read_isolation_verified', {
      backendPid: client.processID,
      crossUserCommandVisible: false,
    });

    const planB = await store.createPlanDraft(userB, {
      plan: { label: '004i-adapter-b' },
      changeReason: '004i_adapter_collision',
    }, { now: '2026-08-25T05:00:00.000Z' });
    await client.query('SAVEPOINT cross_user_command_collision');
    let collisionCode = null;
    try {
      await store.recordPlanRevisionCommand(userB, commandId, {
        planId: planB.planId,
        status: 'draft_created',
        now: '2026-08-25T05:01:00.000Z',
      });
    } catch (error) {
      collisionCode = normalizeErrorCode(error);
    }
    await client.query('ROLLBACK TO SAVEPOINT cross_user_command_collision');
    assertCondition(
      collisionCode === '23505',
      'CROSS_USER_PLAN_REVISION_COMMAND_COLLISION_NOT_REJECTED'
    );
    evidence.record('cross_user_command_collision_rejected', {
      backendPid: client.processID,
      errorCode: collisionCode,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('plan_revision_command_adapter_sandbox_rolled_back', {
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
        'SELECT (SELECT count(*)::int FROM app.users WHERE user_id = $1) AS users, (SELECT count(*)::int FROM app.user_service_status WHERE user_id = $1) AS service_status, (SELECT count(*)::int FROM app.user_service_transitions WHERE user_id = $1) AS service_transitions, (SELECT count(*)::int FROM app.user_plan_versions WHERE user_id = $1) AS plans, (SELECT count(*)::int FROM app.plan_state_transitions WHERE user_id = $1) AS plan_transitions, (SELECT count(*)::int FROM app.plan_revision_commands WHERE user_id = $1) AS commands',
        [sandboxUserId]
      );
      countsByUser.push(result.rows[0]);
    }
    const counts = countsByUser.flatMap((row) => Object.values(row));
    assertCondition(
      counts.every((count) => count === 0),
      'PLAN_REVISION_COMMAND_ADAPTER_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('plan_revision_command_adapter_cleanup_proven', {
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
  const config = assert004iCloudEnvironment(process.env);
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
      batch: '004i-adapter-cloud',
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
      batch: '004i-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004iCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};
