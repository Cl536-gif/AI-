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

function assert004dCloudEnvironment(env = process.env) {
  if (String(env.RUN_004D_ACTIVITY_SETTINGS_VERIFY || '').trim() !== CONFIRMATION) {
    throw Object.assign(new Error('004d真实云端验证尚未获得明确授权'), {
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
        batch: '004d-adapter-cloud',
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
  const userA = `acct:004d_a_${suffix}`;
  const userB = `acct:004d_b_${suffix}`;
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const store = createSandboxStore(client);

    const first = await store.recordActivity(userA);
    const defaults = await store.getUserSettings(userA);
    assertCondition(
      first.previousActiveAt === null
        && Boolean(first.now)
        && defaults?.timezone === 'Asia/Shanghai'
        && defaults.locale === 'zh-CN'
        && defaults.lastActiveAt === first.now,
      'ACTIVITY_DEFAULT_SETTINGS_MISMATCH'
    );
    evidence.record('first_activity_and_default_settings_verified', {
      backendPid: client.processID,
      previousActiveAtEmpty: true,
      defaultTimezoneMatched: true,
      defaultLocaleMatched: true,
    });

    const second = await store.recordActivity(userA);
    assertCondition(
      second.previousActiveAt === first.now
        && Date.parse(second.now) >= Date.parse(second.previousActiveAt),
      'REPEATED_ACTIVITY_TIMESTAMP_MISMATCH'
    );
    evidence.record('repeated_activity_timestamp_verified', {
      backendPid: client.processID,
      previousTimestampMatched: true,
      timestampMonotonic: true,
    });

    const updated = await store.updateUserTimezone(userA, 'UTC');
    const reread = await store.getUserSettings(userA);
    assertCondition(
      updated?.timezone === 'UTC'
        && updated.locale === 'zh-CN'
        && reread?.timezone === 'UTC',
      'TIMEZONE_UPDATE_OR_REREAD_MISMATCH'
    );
    evidence.record('timezone_update_and_reread_verified', {
      backendPid: client.processID,
      timezoneMatched: true,
      localePreserved: true,
    });

    await client.query('SAVEPOINT invalid_timezone');
    let invalidCode = null;
    try {
      await store.updateUserTimezone(userA, 'Not/A_Real_Timezone');
    } catch (error) {
      invalidCode = normalizeErrorCode(error);
    }
    await client.query('ROLLBACK TO SAVEPOINT invalid_timezone');
    const afterInvalid = await store.getUserSettings(userA);
    assertCondition(
      invalidCode === '22023' && afterInvalid?.timezone === 'UTC',
      'INVALID_TIMEZONE_NOT_SAFELY_REJECTED'
    );
    evidence.record('invalid_timezone_rejected_without_mutation', {
      backendPid: client.processID,
      errorCode: invalidCode,
      timezoneRemainsUtc: true,
    });

    const userBSettings = await store.getUserSettings(userB);
    assertCondition(userBSettings === null, 'CROSS_USER_SETTINGS_VISIBLE');
    evidence.record('cross_user_settings_isolation_verified', {
      backendPid: client.processID,
      crossUserSettingsVisible: false,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackError = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('activity_settings_adapter_sandbox_rolled_back', {
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
      'SELECT count(*)::int AS users FROM app.users WHERE user_id = $1',
      [userA]
    );
    assertCondition(
      result.rows[0]?.users === 0,
      'ACTIVITY_SETTINGS_ADAPTER_SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('activity_settings_adapter_cleanup_proven', {
      backendPid: cleanupClient.processID,
      remainingUsers: result.rows[0].users,
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
  const config = assert004dCloudEnvironment(process.env);
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
      batch: '004d-adapter-cloud',
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
      batch: '004d-adapter-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  assert004dCloudEnvironment,
  createRecorder,
  run,
  verifyAdapterInRollbackSandbox,
};
