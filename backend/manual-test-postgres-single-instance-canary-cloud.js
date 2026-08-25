const crypto = require('crypto');
const { createPostgresPool } = require('./src/db/postgresPool');
const { checkPostgresReadiness } = require('./src/db/postgresReadiness');
const { isPrivateIpv4, normalizeErrorCode } = require('./src/db/postgresCloudVerification');
const { parsePostgresPoolConfig } = require('./src/db/postgresPoolConfig');
const {
  assertTencentPostgresCutoverAllowed,
} = require('./src/stores/tencentPostgresCutoverGate');
const {
  configureUserStoreFromEnv,
} = require('./src/stores/userStoreProvider');
const {
  getMissingUserStoreMethods,
} = require('./src/stores/userStoreContract');
const {
  createTencentPostgresUserStore,
} = require('./src/stores/tencentPostgresUserStore');

const CONFIRMATION = 'CONFIRMED_POSTGRES_SINGLE_INSTANCE_CANARY';

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function assertCondition(condition, code) {
  if (!condition) fail(code);
}

function assert005bCanaryEnvironment(env = process.env) {
  if (String(env.RUN_005B_CANARY_VERIFY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED', '005b真实灰度验证需要独立显式确认');
  }
  if (String(env.USER_STORE_ADAPTER || '').trim().toLowerCase() !== 'tencent-postgres') {
    fail('POSTGRES_CANARY_ADAPTER_REQUIRED', '005b只允许在PostgreSQL灰度修订运行');
  }
  const gate = assertTencentPostgresCutoverAllowed({ env });
  const config = parsePostgresPoolConfig(env);
  if (!isPrivateIpv4(config.host)) fail('PRIVATE_IPV4_REQUIRED');
  if (config.port !== 5432) fail('POSTGRES_PORT_MUST_BE_5432');
  if (config.poolMax !== 1 || gate.maxInstances !== 1) fail('POSTGRES_CANARY_SCOPE_INVALID');
  return Object.freeze({ gate, config });
}

function createRecorder({ write = console.log, now = () => new Date() } = {}) {
  const checks = [];
  return Object.freeze({
    checks,
    record(check, details = {}) {
      const entry = Object.freeze({
        batch: '005b-postgres-single-instance-canary',
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
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      return callback(client);
    },
    async runPostgresClient(callback) {
      return callback(client);
    },
  });
}

async function verifyRollbackSandbox(pool, evidence) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const userId = `acct:005b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    await store.ensureUser(userId);
    const activity = await store.recordActivity(userId);
    const settings = await store.getUserSettings(userId);
    assertCondition(Boolean(activity.now) && settings?.userId === userId, 'ACTIVITY_SETTINGS_FAILED');
    evidence.record('identity_activity_and_settings_verified', {
      backendPid: client.processID,
      activityRecorded: true,
      settingsRead: true,
    });

    const profile = await store.updateProfile(userId, {
      body: {
        equationSex: 'female',
        ageYears: 28,
        heightCm: 165,
        currentWeightKg: 60,
        dailyActivity: '久坐',
      },
      diet: {
        scene: 'mixed',
        tastePreferences: ['清淡'],
        goals: ['稳定饮食'],
      },
    }, { source: 'system', expectedVersion: 0 });
    const rereadProfile = await store.getProfile(userId);
    assertCondition(
      profile.profileVersion === 1
        && rereadProfile?.profileVersion === 1
        && rereadProfile.profile.body.currentWeightKg === 60,
      'PROFILE_WRITE_READ_FAILED'
    );
    evidence.record('profile_write_and_read_verified', {
      backendPid: client.processID,
      profileVersion: 1,
      profileMatched: true,
    });

    const advice = await store.recordAdvice(userId, {
      adviceType: 'ad_hoc_meal_advice',
      serviceMode: 'free',
      content: '005b回滚沙箱通用饮食建议',
      metadata: { source: 'rollback-sandbox' },
      idempotencyKey: `005b-${suffix}`,
    });
    const history = await store.listAdviceHistory(userId, { limit: 5 });
    assertCondition(
      Boolean(advice.adviceId)
        && history.length === 1
        && history[0].adviceId === advice.adviceId,
      'ADVICE_WRITE_READ_FAILED'
    );
    evidence.record('advice_write_and_read_verified', {
      backendPid: client.processID,
      adviceRecorded: true,
      adviceHistoryCount: 1,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('canary_sandbox_rolled_back', {
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
    await cleanupClient.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const userResult = await cleanupClient.query(
      'SELECT count(*)::int AS count FROM app.users WHERE user_id = $1',
      [userId]
    );
    const profileResult = await cleanupClient.query(
      'SELECT count(*)::int AS count FROM app.user_profile_versions WHERE user_id = $1',
      [userId]
    );
    const adviceResult = await cleanupClient.query(
      'SELECT count(*)::int AS count FROM app.user_advice_history WHERE user_id = $1',
      [userId]
    );
    assertCondition(
      userResult.rows[0].count === 0
        && profileResult.rows[0].count === 0
        && adviceResult.rows[0].count === 0,
      'CANARY_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('canary_cleanup_proven', {
      backendPid: cleanupClient.processID,
      remainingUsers: 0,
      remainingProfiles: 0,
      remainingAdvice: 0,
    });
  } catch (error) {
    cleanupError = error;
    throw error;
  } finally {
    if (cleanupOpen) await cleanupClient.query('ROLLBACK').catch((error) => { cleanupError = error; });
    cleanupClient.release(cleanupError);
    if (cleanupError) throw cleanupError;
  }
}

async function run() {
  const { config } = assert005bCanaryEnvironment(process.env);
  const evidence = createRecorder();
  const selectedStore = configureUserStoreFromEnv({ env: process.env });
  assertCondition(getMissingUserStoreMethods(selectedStore).length === 0, 'PROVIDER_CONTRACT_INCOMPLETE');
  evidence.record('provider_and_cutover_gate_verified', {
    processPid: process.pid,
    adapterSelected: 'tencent-postgres',
    contractMethodCount: 37,
    privateNetworkGuardPassed: true,
    poolMax: config.poolMax,
  });

  const pool = createPostgresPool({ config });
  try {
    await checkPostgresReadiness({ pool });
    evidence.record('database_identity_and_readiness_verified', {
      processPid: process.pid,
      ready: true,
    });
    await verifyRollbackSandbox(pool, evidence);
    console.log(JSON.stringify({
      batch: '005b-postgres-single-instance-canary',
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
      batch: '005b-postgres-single-instance-canary',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert005bCanaryEnvironment,
  createRecorder,
  createSandboxStore,
  run,
  verifyRollbackSandbox,
};
