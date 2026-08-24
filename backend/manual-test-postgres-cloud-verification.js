const {
  createPostgresPool,
} = require('./src/db/postgresPool');
const { checkPostgresReadiness } = require('./src/db/postgresReadiness');
const {
  withPostgresClient,
  withUserTransaction,
} = require('./src/db/postgresTransaction');
const {
  assertCloudVerificationEnvironment,
  assertExpectedIdentity,
  createEvidenceRecorder,
  createVerificationConfig,
  createVerificationIds,
  normalizeErrorCode,
} = require('./src/db/postgresCloudVerification');

function assertCondition(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function contextIsEmpty(value) {
  return value === null || value === '';
}

async function readConnectionState(pool) {
  return withPostgresClient(async (client) => {
    const result = await client.query(
      [
        'SELECT current_database() AS database_name,',
        '       current_user AS role_name,',
        '       pg_backend_pid() AS backend_pid,',
        '       app.current_user_id() AS user_context,',
        "       current_setting('app.user_id', true) AS raw_user_context,",
        '       (SELECT count(*)::int FROM app.users) AS visible_users,',
        '       (SELECT count(*)::int FROM app.user_events) AS visible_events',
      ].join('\n'),
      []
    );
    return result.rows[0];
  }, { pool });
}

async function verifyWrapperReuse(pool, config, ids, evidence) {
  const first = await withUserTransaction(ids.userA, async (client) => {
    const result = await client.query(
      'SELECT app.current_user_id() AS user_context, pg_backend_pid() AS backend_pid',
      []
    );
    return result.rows[0];
  }, { pool, config });
  assertCondition(first.user_context === ids.userA, 'USER_A_CONTEXT_MISMATCH');
  evidence.record('user_a_transaction_committed', {
    backendPid: first.backend_pid,
    userContext: first.user_context,
  });

  const between = await readConnectionState(pool);
  assertExpectedIdentity(between);
  assertCondition(between.backend_pid === first.backend_pid, 'PHYSICAL_CONNECTION_NOT_REUSED');
  assertCondition(contextIsEmpty(between.user_context), 'USER_CONTEXT_LEAKED_AFTER_COMMIT');
  assertCondition(contextIsEmpty(between.raw_user_context), 'RAW_USER_CONTEXT_LEAKED_AFTER_COMMIT');
  assertCondition(between.visible_users === 0 && between.visible_events === 0, 'RLS_WITHOUT_CONTEXT_FAILED');
  evidence.record('same_connection_context_cleared', {
    backendPid: between.backend_pid,
    userContextEmpty: true,
    rawUserContextEmpty: true,
    visibleUsers: between.visible_users,
    visibleEvents: between.visible_events,
  });

  const second = await withUserTransaction(ids.userB, async (client) => {
    const result = await client.query(
      'SELECT app.current_user_id() AS user_context, pg_backend_pid() AS backend_pid',
      []
    );
    return result.rows[0];
  }, { pool, config });
  assertCondition(second.user_context === ids.userB, 'USER_B_CONTEXT_MISMATCH');
  assertCondition(second.backend_pid === first.backend_pid, 'USER_B_USED_DIFFERENT_CONNECTION');
  evidence.record('same_connection_user_b_isolated', {
    backendPid: second.backend_pid,
    userContext: second.user_context,
  });
}

async function verifyRollbackRecovery(pool, config, ids, evidence) {
  let failureCode = null;
  try {
    await withUserTransaction(ids.userA, async (client) => {
      await client.query('SELECT 1 / 0 AS forced_failure', []);
    }, { pool, config });
  } catch (error) {
    failureCode = normalizeErrorCode(error);
  }
  assertCondition(failureCode === '22012', 'EXPECTED_DIVISION_ERROR_NOT_OBSERVED');

  const recovered = await withUserTransaction(ids.userB, async (client) => {
    const result = await client.query(
      'SELECT app.current_user_id() AS user_context, pg_backend_pid() AS backend_pid',
      []
    );
    return result.rows[0];
  }, { pool, config });
  assertCondition(recovered.user_context === ids.userB, 'CONNECTION_DID_NOT_RECOVER_AFTER_ROLLBACK');
  evidence.record('sql_error_rolled_back_and_connection_recovered', {
    errorCode: failureCode,
    backendPid: recovered.backend_pid,
  });
}

async function verifySandboxedDatabaseRules(pool, ids, evidence) {
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userA]);
    await client.query(
      "INSERT INTO app.users (user_id, status) VALUES ($1, 'active')",
      [ids.userA]
    );
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userB]);
    await client.query(
      "INSERT INTO app.users (user_id, status) VALUES ($1, 'active')",
      [ids.userB]
    );

    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userA]);
    const hiddenUser = await client.query(
      'SELECT count(*)::int AS count FROM app.users WHERE user_id = $1',
      [ids.userB]
    );
    assertCondition(hiddenUser.rows[0].count === 0, 'USER_A_CAN_READ_USER_B');

    const occurredAt = new Date().toISOString();
    const eventPayload = JSON.stringify({
      eventId: ids.eventId,
      eventType: 'check_in',
      occurredAt,
      payload: { verificationBatch: '003d' },
      source: 'system',
      idempotencyKey: ids.idempotencyKey,
    });
    const eventFirst = await client.query(
      'SELECT app.append_current_user_event($1::jsonb) AS event',
      [eventPayload]
    );
    const eventReplay = await client.query(
      'SELECT app.append_current_user_event($1::jsonb) AS event',
      [eventPayload]
    );
    assertCondition(
      eventFirst.rows[0].event.eventId === ids.eventId
        && eventReplay.rows[0].event.eventId === ids.eventId,
      'IDEMPOTENT_RPC_RESULT_MISMATCH'
    );
    const eventCount = await client.query(
      'SELECT count(*)::int AS count FROM app.user_events WHERE idempotency_key = $1',
      [ids.idempotencyKey]
    );
    assertCondition(eventCount.rows[0].count === 1, 'IDEMPOTENT_RPC_CREATED_DUPLICATE');
    evidence.record('rls_and_idempotent_rpc_verified_in_sandbox', {
      backendPid: client.processID,
      crossUserRowsVisible: hiddenUser.rows[0].count,
      rpcRowsCreated: eventCount.rows[0].count,
      replayMatched: true,
    });

    await client.query('SAVEPOINT verify_ddl_permission');
    let ddlCode = null;
    try {
      await client.query(`CREATE TABLE app.${ids.ddlTable} (id integer)`);
    } catch (error) {
      ddlCode = normalizeErrorCode(error);
    }
    await client.query('ROLLBACK TO SAVEPOINT verify_ddl_permission');
    assertCondition(ddlCode === '42501', 'DIET_APP_DDL_WAS_NOT_REJECTED');
    evidence.record('diet_app_create_in_app_rejected', {
      backendPid: client.processID,
      errorCode: ddlCode,
    });
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    let rollbackFailure = null;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        evidence.record('sandbox_transaction_rolled_back', {
          backendPid: client.processID,
          cleanup: 'rollback',
        });
      } catch (rollbackError) {
        releaseError = rollbackError;
        rollbackFailure = rollbackError;
      }
    }
    client.release(releaseError);
    if (rollbackFailure) throw rollbackFailure;
  }

  const cleanupClient = await pool.connect();
  let cleanupTransactionOpen = false;
  try {
    await cleanupClient.query('BEGIN');
    cleanupTransactionOpen = true;
    const counts = [];
    for (const userId of [ids.userA, ids.userB]) {
      await cleanupClient.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await cleanupClient.query(
        [
          'SELECT',
          '  (SELECT count(*)::int FROM app.users WHERE user_id = $1) AS users,',
          '  (SELECT count(*)::int FROM app.user_events WHERE event_id = $2) AS events'
        ].join('\n'),
        [userId, ids.eventId]
      );
      counts.push(result.rows[0]);
    }
    assertCondition(
      counts.every((row) => row.users === 0 && row.events === 0),
      'SANDBOX_CLEANUP_NOT_PROVEN'
    );
    evidence.record('sandbox_cleanup_proven', {
      backendPid: cleanupClient.processID,
      remainingUsers: counts.reduce((sum, row) => sum + row.users, 0),
      remainingEvents: counts.reduce((sum, row) => sum + row.events, 0),
    });
  } finally {
    let cleanupRollbackError = null;
    if (cleanupTransactionOpen) {
      try {
        await cleanupClient.query('ROLLBACK');
      } catch (error) {
        cleanupRollbackError = error;
      }
    }
    cleanupClient.release(cleanupRollbackError);
    if (cleanupRollbackError) throw cleanupRollbackError;
  }
}

async function verifyPoolExhaustion(pool, evidence) {
  const holder = await pool.connect();
  const startedAt = Date.now();
  let timeoutCode = null;
  let unexpectedClient = null;
  try {
    unexpectedClient = await pool.connect();
  } catch (error) {
    timeoutCode = normalizeErrorCode(error, 'POOL_CONNECT_TIMEOUT');
  } finally {
    if (unexpectedClient) unexpectedClient.release();
    holder.release();
  }
  const waitMs = Date.now() - startedAt;
  assertCondition(timeoutCode !== null, 'POOL_EXHAUSTION_DID_NOT_TIMEOUT');
  assertCondition(waitMs >= 500 && waitMs <= 3000, 'POOL_TIMEOUT_OUTSIDE_EXPECTED_WINDOW');

  const recovered = await pool.connect();
  const backendPid = recovered.processID;
  recovered.release();
  evidence.record('pool_exhaustion_timed_out_and_recovered', {
    backendPid,
    errorCode: timeoutCode,
    waitMs,
  });
}

async function run() {
  const baseConfig = assertCloudVerificationEnvironment(process.env);
  const config = createVerificationConfig(baseConfig);
  const ids = createVerificationIds();
  const evidence = createEvidenceRecorder();
  const pool = createPostgresPool({ config });
  let poolEnded = false;

  evidence.record('verification_started', {
    processPid: process.pid,
    adapterRemainsSqlite: true,
    privateNetworkGuardPassed: true,
    testPoolMax: config.poolMax,
  });
  try {
    await checkPostgresReadiness({ pool });
    const initial = await readConnectionState(pool);
    assertExpectedIdentity(initial);
    assertCondition(contextIsEmpty(initial.user_context), 'INITIAL_CONTEXT_NOT_EMPTY');
    assertCondition(contextIsEmpty(initial.raw_user_context), 'INITIAL_RAW_CONTEXT_NOT_EMPTY');
    evidence.record('database_identity_and_readiness_verified', {
      backendPid: initial.backend_pid,
      databaseMatched: true,
      roleMatched: true,
      userContextEmpty: true,
      rawUserContextEmpty: true,
    });

    await verifyWrapperReuse(pool, config, ids, evidence);
    await verifyRollbackRecovery(pool, config, ids, evidence);
    await verifySandboxedDatabaseRules(pool, ids, evidence);
    await verifyPoolExhaustion(pool, evidence);

    await pool.end();
    poolEnded = true;
    let endRejected = false;
    try {
      await pool.connect();
    } catch (_error) {
      endRejected = true;
    }
    assertCondition(endRejected, 'POOL_ACCEPTED_BORROW_AFTER_END');
    evidence.record('pool_end_rejects_new_borrow', { rejected: true });
    const summary = {
      batch: '003d',
      status: 'PASS',
      processPid: process.pid,
      checkCount: evidence.checks.length,
      cleanup: 'PASS',
    };
    console.log(JSON.stringify(summary));
  } finally {
    if (!poolEnded) await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      batch: '003d',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error),
    }));
    process.exitCode = 1;
  });
}

module.exports = { run };
