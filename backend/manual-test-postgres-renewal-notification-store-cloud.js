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

function assert004jCloudEnvironment(env = process.env) {
  if (String(env.RUN_004J_RENEWAL_NOTIFICATION_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004j真实云端验证尚未获得明确授权'), {
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
        batch: '004j-adapter-cloud',
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
  const userA = `acct:004j_a_${suffix}`;
  const userB = `acct:004j_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    await store.setServiceStatus(userA, {
      status: 'trial_active',
      trialStartedAt: '2026-08-01T00:00:00.000Z',
      trialEndsAt: '2026-08-15T00:00:00.000Z',
      renewalReminderAt: '2026-08-14T00:00:00.000Z',
      officialPlanId: `004j-plan-a-${suffix}`,
    }, { reason: '004j_adapter_trial_a' });

    const early = await store.enqueueDueRenewalReminders({
      now: '2026-08-13T23:59:59.000Z',
      limit: 100,
    });
    assertCondition(early.length === 0, 'RENEWAL_NOTIFICATION_ENQUEUED_EARLY');
    evidence.record('reminder_not_enqueued_early', {
      backendPid: client.processID,
      enqueued: 0,
    });

    const due = await store.enqueueDueRenewalReminders({
      now: '2026-08-14T00:00:00.000Z',
      limit: 100,
    });
    const repeated = await store.enqueueDueRenewalReminders({
      now: '2026-08-14T01:00:00.000Z',
      limit: 100,
    });
    const notification = due[0];
    assertCondition(
      due.length === 1
        && repeated.length === 1
        && notification.notificationId === repeated[0].notificationId
        && notification.userId === userA
        && notification.notificationType === 'trial_renewal_day_13'
        && notification.status === 'pending'
        && notification.attempts === 0
        && notification.scheduledAt === '2026-08-14T00:00:00.000Z',
      'RENEWAL_NOTIFICATION_ENQUEUE_IDEMPOTENCY_OR_MAPPING_MISMATCH'
    );
    evidence.record('due_reminder_idempotency_and_mapping_verified', {
      backendPid: client.processID,
      sameNotificationId: true,
      timestampsNormalized: true,
    });

    const pending = await store.listPendingNotifications({
      now: '2026-08-14T01:00:00.000Z',
      limit: 100,
    });
    assertCondition(
      pending.some((item) => item.notificationId === notification.notificationId),
      'PENDING_RENEWAL_NOTIFICATION_NOT_LISTED'
    );
    evidence.record('pending_notification_list_verified', {
      backendPid: client.processID,
      notificationFound: true,
    });

    await store.setServiceStatus(userB, {
      status: 'trial_active',
      trialStartedAt: '2026-07-31T12:00:00.000Z',
      trialEndsAt: '2026-08-14T12:00:00.000Z',
      renewalReminderAt: '2026-08-13T12:00:00.000Z',
      officialPlanId: `004j-plan-b-${suffix}`,
    }, { reason: '004j_adapter_trial_b' });
    const afterExpiry = await store.enqueueDueRenewalReminders({
      now: '2026-08-14T13:00:00.000Z',
      limit: 100,
    });
    assertCondition(
      afterExpiry.some((item) => item.notificationId === notification.notificationId)
        && !afterExpiry.some((item) => item.userId === userB),
      'EXPIRED_TRIAL_RENEWAL_NOTIFICATION_NOT_SKIPPED'
    );
    evidence.record('expired_trial_skipped', {
      backendPid: client.processID,
      expiredUserEnqueued: false,
    });

    const firstMark = await store.markNotificationSent(notification.notificationId, {
      sentAt: '2026-08-14T13:01:00.000Z',
    });
    const repeatedMark = await store.markNotificationSent(notification.notificationId, {
      sentAt: '2026-08-14T13:02:00.000Z',
    });
    const pendingAfterSend = await store.listPendingNotifications({
      now: '2026-08-14T14:00:00.000Z',
      limit: 100,
    });
    assertCondition(
      firstMark === true
        && repeatedMark === false
        && !pendingAfterSend.some((item) => item.notificationId === notification.notificationId),
      'RENEWAL_NOTIFICATION_SEND_CONFIRMATION_NOT_IDEMPOTENT'
    );
    evidence.record('notification_marked_sent_once', {
      backendPid: client.processID,
      firstMark: true,
      repeatedMark: false,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('renewal_notification_adapter_sandbox_rolled_back', {
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
    for (const sandboxUserId of [userA, userB]) {
      assertCondition(
        await store.getServiceStatus(sandboxUserId) === null,
        'RENEWAL_NOTIFICATION_ADAPTER_SERVICE_CLEANUP_NOT_PROVEN'
      );
    }
    const pending = await store.listPendingNotifications({
      now: '2026-08-15T00:00:00.000Z',
      limit: 500,
    });
    assertCondition(
      !pending.some((item) => item.userId === userA || item.userId === userB),
      'RENEWAL_NOTIFICATION_ADAPTER_QUEUE_CLEANUP_NOT_PROVEN'
    );
    evidence.record('renewal_notification_adapter_cleanup_proven', {
      backendPid: cleanupClient.processID,
      sandboxRowsVisible: 0,
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
  const config = assert004jCloudEnvironment(process.env);
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
      batch: '004j-adapter-cloud',
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
      batch: '004j-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004jCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};
