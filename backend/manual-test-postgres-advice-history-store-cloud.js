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

function assert004kCloudEnvironment(env = process.env) {
  if (String(env.RUN_004K_ADVICE_HISTORY_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004k真实云端验证尚未获得明确授权'), {
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
        batch: '004k-adapter-cloud',
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
  const userA = `acct:004k_a_${suffix}`;
  const userB = `acct:004k_b_${suffix}`;
  const sharedKey = `004k-shared-${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    const first = await store.recordAdvice(userA, {
      adviceType: 'initial_meal_plan',
      serviceMode: 'free',
      content: '004k适配器沙箱建议A',
      metadata: { source: 'cloud-sandbox', version: 1 },
      threadId: `thread-${suffix}`,
      idempotencyKey: sharedKey,
      createdAt: '2026-08-25T08:00:00.000Z',
    });
    assertCondition(
      Boolean(first.adviceId)
        && first.userId === userA
        && first.adviceType === 'initial_meal_plan'
        && first.serviceMode === 'free'
        && first.metadata.version === 1
        && first.createdAt === '2026-08-25T08:00:00.000Z',
      'ADVICE_WRITE_OR_MAPPING_MISMATCH'
    );
    evidence.record('advice_write_and_mapping_verified', {
      backendPid: client.processID,
      generatedAdviceId: true,
      timestampNormalized: true,
      metadataMapped: true,
    });

    const repeated = await store.recordAdvice(userA, {
      adviceType: 'ad_hoc_meal_advice',
      serviceMode: 'long_term_onboarding',
      content: '004k重试不应覆盖原建议',
      metadata: { source: 'retry' },
      threadId: `retry-${suffix}`,
      idempotencyKey: sharedKey,
      createdAt: '2026-08-25T08:30:00.000Z',
    });
    assertCondition(
      repeated.adviceId === first.adviceId
        && repeated.content === first.content
        && repeated.createdAt === first.createdAt
        && repeated.metadata.version === 1,
      'ADVICE_IDEMPOTENT_RETRY_MISMATCH'
    );
    evidence.record('advice_idempotent_retry_verified', {
      backendPid: client.processID,
      sameAdviceId: true,
      originalSnapshotPreserved: true,
    });

    const second = await store.recordAdvice(userA, {
      adviceType: 'ad_hoc_meal_advice',
      serviceMode: 'free',
      content: '004k适配器沙箱建议A第二条',
      metadata: { source: 'cloud-sandbox', version: 2 },
      threadId: `thread-${suffix}`,
      idempotencyKey: `004k-second-${suffix}`,
      createdAt: '2026-08-25T09:00:00.000Z',
    });
    const history = await store.listAdviceHistory(userA, { limit: 10 });
    assertCondition(
      history.length === 2
        && history[0].adviceId === second.adviceId
        && history[1].adviceId === first.adviceId
        && history[0].metadata.version === 2,
      'ADVICE_HISTORY_ORDER_OR_SNAPSHOT_MISMATCH'
    );
    evidence.record('advice_history_order_and_snapshot_verified', {
      backendPid: client.processID,
      adviceCount: history.length,
      newestFirst: true,
    });

    let invalidRejected = false;
    try {
      await store.recordAdvice(userA, {
        content: 'invalid metadata',
        metadata: [],
        idempotencyKey: `004k-invalid-${suffix}`,
      });
    } catch (error) {
      invalidRejected = /建议元数据格式不正确/.test(error.message);
    }
    const afterInvalid = await store.listAdviceHistory(userA, { limit: 10 });
    assertCondition(
      invalidRejected && afterInvalid.length === 2,
      'INVALID_ADVICE_NOT_SAFELY_REJECTED'
    );
    evidence.record('invalid_advice_rejected_without_mutation', {
      backendPid: client.processID,
      rejected: true,
      adviceCountRemains: afterInvalid.length,
    });

    const userBHistory = await store.listAdviceHistory(userB, { limit: 10 });
    const userBAdvice = await store.recordAdvice(userB, {
      content: '004k适配器沙箱建议B',
      idempotencyKey: sharedKey,
      createdAt: '2026-08-25T10:00:00.000Z',
    });
    assertCondition(
      userBHistory.length === 0
        && userBAdvice.userId === userB
        && userBAdvice.adviceId !== first.adviceId
        && userBAdvice.adviceType === 'meal_advice'
        && userBAdvice.serviceMode === 'free',
      'CROSS_USER_ADVICE_ISOLATION_OR_DEFAULT_MISMATCH'
    );
    evidence.record('cross_user_isolation_and_defaults_verified', {
      backendPid: client.processID,
      crossUserAdviceVisible: false,
      sharedKeyScopedByUser: true,
      defaultsMatched: true,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('advice_history_adapter_sandbox_rolled_back', {
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
        await store.getUserSettings(sandboxUserId) === null,
        'ADVICE_HISTORY_ADAPTER_USER_CLEANUP_NOT_PROVEN'
      );
      assertCondition(
        (await store.listAdviceHistory(sandboxUserId, { limit: 10 })).length === 0,
        'ADVICE_HISTORY_ADAPTER_ADVICE_CLEANUP_NOT_PROVEN'
      );
    }
    evidence.record('advice_history_adapter_cleanup_proven', {
      backendPid: cleanupClient.processID,
      remainingUsers: 0,
      remainingAdvice: 0,
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
  const config = assert004kCloudEnvironment(process.env);
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
      batch: '004k-adapter-cloud',
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
      batch: '004k-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004kCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};
