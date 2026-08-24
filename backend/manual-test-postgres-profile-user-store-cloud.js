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

function assert004cCloudEnvironment(env = process.env) {
  if (String(env.RUN_004C_PROFILE_STORE_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004c真实云端验证尚未获得明确授权'), {
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
        batch: '004c-adapter-cloud',
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

function createSandboxStore(client, config) {
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
    config,
  });
}

async function verifyAdapterInRollbackSandbox(pool, config, evidence) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const userA = `acct:004c_a_${suffix}`;
  const userB = `acct:004c_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client, config);

    const version1 = await store.updateProfile(userA, {
      body: {
        equationSex: 'female',
        ageYears: 28,
        heightCm: 165,
        currentWeightKg: 60,
        targetWeightKg: 56,
        dailyActivity: '久坐',
      },
      diet: {
        scene: 'mixed',
        cafeteriaMode: 'mixed',
        budgetCnyPerMeal: 30,
        tastePreferences: ['清淡'],
        goals: ['稳定减脂'],
        exerciseBaseline: '每周步行三次',
      },
    }, { source: 'user', expectedVersion: 0 });
    assertCondition(version1.profileVersion === 1, 'PROFILE_VERSION_1_MISMATCH');

    const read1 = await store.getProfile(userA);
    assertCondition(
      read1?.profileVersion === 1 && read1.profile.body.currentWeightKg === 60,
      'PROFILE_VERSION_1_READ_MISMATCH'
    );

    const version2 = await store.updateProfile(userA, {
      body: {
        currentWeightKg: 59.5,
        recentWeightChange: '下降0.5kg',
      },
    }, { source: 'user', expectedVersion: 1 });
    assertCondition(version2.profileVersion === 2, 'PROFILE_VERSION_2_MISMATCH');

    await store.recordConsent({
      userId: userA,
      consentType: 'menstrual_tracking',
      status: 'granted',
      recordedAt: new Date().toISOString(),
      source: 'user',
    });
    const version3 = await store.updateProfile(userA, {
      menstrualTracking: {
        applicability: 'applicable',
        status: 'active',
      },
    }, { source: 'user', expectedVersion: 2 });
    assertCondition(version3.profileVersion === 3, 'PROFILE_VERSION_3_MISMATCH');

    const current = await store.getProfile(userA);
    assertCondition(
      current?.profileVersion === 3
        && current.profile.body.currentWeightKg === 59.5
        && current.profile.menstrualTracking.status === 'active',
      'CURRENT_PROFILE_RECONSTRUCTION_FAILED'
    );
    const revisions = await store.listProfileRevisions(userA, { limit: 10 });
    assertCondition(
      revisions.length === 3
        && revisions.map((item) => item.profileVersion).join(',') === '3,2,1'
        && revisions[0].snapshot.menstrualTracking.status === 'active'
        && revisions[1].snapshot.menstrualTracking.status === 'unknown',
      'PROFILE_REVISION_RECONSTRUCTION_FAILED'
    );
    evidence.record('profile_versions_and_sensitive_history_reconstructed', {
      backendPid: client.processID,
      currentVersion: current.profileVersion,
      revisionCount: revisions.length,
      sensitiveCurrentVisibleWithConsent: true,
      sensitiveHistoryAbsentBeforeConsent: true,
    });

    await client.query('SAVEPOINT stale_profile_version');
    let staleCode = null;
    try {
      await store.updateProfile(userA, {
        body: { currentWeightKg: 58 },
      }, { source: 'user', expectedVersion: 2 });
    } catch (error) {
      staleCode = normalizeErrorCode(error);
    }
    await client.query('ROLLBACK TO SAVEPOINT stale_profile_version');
    assertCondition(staleCode === '40001', 'STALE_PROFILE_VERSION_NOT_REJECTED');
    evidence.record('stale_expected_version_rejected', {
      backendPid: client.processID,
      errorCode: staleCode,
      versionRemains: 3,
    });

    const userBProfile = await store.getProfile(userB);
    const userBRevisions = await store.listProfileRevisions(userB, { limit: 10 });
    assertCondition(
      userBProfile === null && userBRevisions.length === 0,
      'CROSS_USER_PROFILE_VISIBLE'
    );
    evidence.record('cross_user_profile_isolation_verified', {
      backendPid: client.processID,
      crossUserProfileVisible: false,
      crossUserRevisionCount: userBRevisions.length,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('profile_adapter_sandbox_rolled_back', {
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
      'SELECT (SELECT count(*)::int FROM app.users WHERE user_id = $1) AS users, (SELECT count(*)::int FROM app.user_profiles WHERE user_id = $1) AS profiles, (SELECT count(*)::int FROM app.user_menstrual_profiles WHERE user_id = $1) AS menstrual_profiles, (SELECT count(*)::int FROM app.profile_revisions WHERE user_id = $1) AS revisions, (SELECT count(*)::int FROM app.menstrual_profile_revisions WHERE user_id = $1) AS menstrual_revisions, (SELECT count(*)::int FROM app.user_consents WHERE user_id = $1) AS consents, (SELECT count(*)::int FROM app.user_profile_versions WHERE user_id = $1) AS versions, (SELECT count(*)::int FROM app.user_profile_version_history WHERE user_id = $1) AS version_history',
      [userA]
    );
    const counts = result.rows[0];
    assertCondition(
      Object.values(counts).every((count) => count === 0),
      'PROFILE_ADAPTER_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('profile_adapter_cleanup_proven', {
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
  const config = assert004cCloudEnvironment(process.env);
  const evidence = createRecorder();
  const pool = createPostgresPool({ config });
  try {
    evidence.record('verification_started', {
      processPid: process.pid,
      adapterRemainsSqlite: true,
      privateNetworkGuardPassed: true,
      testPoolMax: config.poolMax,
    });
    await verifyAdapterInRollbackSandbox(pool, config, evidence);
    console.log(JSON.stringify({
      batch: '004c-adapter-cloud',
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
      batch: '004c-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004cCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};

