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

function assert004mCloudEnvironment(env = process.env) {
  if (String(env.RUN_004M_IDENTITY_MERGE_READ_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004m真实云端验证尚未获得明确授权'), {
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
        batch: '004m-merge-read-cloud',
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

async function insertSandboxUser(client, userId) {
  await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
  await client.query(
    "INSERT INTO app.users (user_id, status) VALUES ($1, 'active')",
    [userId]
  );
}

async function verifyMergeReadsInRollbackSandbox(pool, evidence) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const sourceUserId = `anon:004m_${suffix}`;
  const targetUserId = `acct:004m_a_${suffix}`;
  const otherUserId = `acct:004m_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    await insertSandboxUser(client, sourceUserId);
    await insertSandboxUser(client, targetUserId);
    await insertSandboxUser(client, otherUserId);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [targetUserId]);
    const mergedResult = await client.query(
      'SELECT app.merge_current_account_from_anonymous($1) AS result',
      [sourceUserId]
    );
    const mergeId = mergedResult.rows[0]?.result?.mergeId;
    assertCondition(Boolean(mergeId), 'MERGE_FIXTURE_NOT_CREATED');
    evidence.record('merge_fixture_created', {
      backendPid: client.processID,
      mergeCreated: true,
    });

    const merge = await store.getUserMerge(targetUserId, sourceUserId);
    assertCondition(
      merge?.mergeId === mergeId
        && merge.sourceUserId === sourceUserId
        && merge.targetUserId === targetUserId
        && merge.status === 'completed'
        && typeof merge.mergedAt === 'string',
      'CURRENT_ACCOUNT_MERGE_MAPPING_MISMATCH'
    );
    evidence.record('current_account_merge_read_verified', {
      backendPid: client.processID,
      ownershipMatched: true,
      timestampNormalized: true,
    });

    const review = await store.getMergeReview(targetUserId, mergeId);
    assertCondition(
      review?.mergeId === mergeId
        && Array.isArray(review.conflicts)
        && Array.isArray(review.eventAudit)
        && review.pendingConflictCount === 0,
      'CURRENT_ACCOUNT_MERGE_REVIEW_MAPPING_MISMATCH'
    );
    evidence.record('current_account_merge_review_verified', {
      backendPid: client.processID,
      emptyConflictArrayMapped: true,
      emptyAuditArrayMapped: true,
    });

    assertCondition(
      await store.getUserMerge(otherUserId, sourceUserId) === null,
      'CROSS_ACCOUNT_MERGE_VISIBLE'
    );
    assertCondition(
      await store.getMergeReview(otherUserId, mergeId) === null,
      'CROSS_ACCOUNT_MERGE_REVIEW_VISIBLE'
    );
    evidence.record('cross_account_merge_reads_isolated', {
      backendPid: client.processID,
      crossAccountRowsVisible: 0,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('merge_read_sandbox_rolled_back', {
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
    for (const userId of [sourceUserId, targetUserId, otherUserId]) {
      await cleanupClient.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      const result = await cleanupClient.query(
        'SELECT count(*)::int AS count FROM app.users WHERE user_id = $1',
        [userId]
      );
      assertCondition(result.rows[0].count === 0, 'MERGE_READ_SANDBOX_CLEANUP_NOT_PROVEN');
    }
    evidence.record('merge_read_cleanup_proven', {
      backendPid: cleanupClient.processID,
      remainingSandboxUsers: 0,
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
  const config = assert004mCloudEnvironment(process.env);
  const evidence = createRecorder();
  const pool = createPostgresPool({ config });
  try {
    evidence.record('verification_started', {
      processPid: process.pid,
      adapterRemainsSqlite: true,
      privateNetworkGuardPassed: true,
      testPoolMax: config.poolMax,
    });
    await verifyMergeReadsInRollbackSandbox(pool, evidence);
    console.log(JSON.stringify({
      batch: '004m-merge-read-cloud',
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
      batch: '004m-merge-read-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004mCloudEnvironment,
  createRecorder,
  run,
  verifyMergeReadsInRollbackSandbox,
};
