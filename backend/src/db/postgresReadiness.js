const {
  EXPECTED_DATABASE,
  EXPECTED_USER,
} = require('./postgresPoolConfig');
const { getPostgresPool } = require('./postgresPool');
const { logSafePostgresError } = require('./postgresDiagnostics');

const DEFAULT_READINESS_TIMEOUT_MS = 2000;
const READINESS_SQL = [
  'SELECT current_database() AS database_name,',
  '       current_user AS role_name,',
  "       current_setting('app.current_user_id', true) AS user_context",
].join('\n');

function createReadinessError(code) {
  const error = new Error('PostgreSQL就绪检查失败');
  error.code = code;
  return error;
}

function assertTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10000) {
    throw new TypeError('PostgreSQL就绪检查超时必须在250—10000毫秒之间');
  }
}

function assertReadinessClient(client) {
  if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
    throw createReadinessError('READINESS_INVALID_CLIENT');
  }
}

function assertReadinessResult(result) {
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  const row = rows.length === 1 ? rows[0] : null;
  const contextIsEmpty = row && (row.user_context === null || row.user_context === '');
  if (
    !row
    || row.database_name !== EXPECTED_DATABASE
    || row.role_name !== EXPECTED_USER
    || !contextIsEmpty
  ) {
    throw createReadinessError('READINESS_IDENTITY_MISMATCH');
  }
}

async function checkPostgresReadiness({
  pool,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
} = {}) {
  assertTimeout(timeoutMs);
  const resolvedPool = pool || getPostgresPool();
  if (!resolvedPool || typeof resolvedPool.connect !== 'function') {
    throw createReadinessError('READINESS_INVALID_POOL');
  }

  const client = await resolvedPool.connect();
  try {
    assertReadinessClient(client);
  } catch (error) {
    if (client && typeof client.release === 'function') client.release(error);
    throw error;
  }

  let releaseWithError = null;
  try {
    const result = await client.query({
      text: READINESS_SQL,
      values: [],
      query_timeout: timeoutMs,
    });
    assertReadinessResult(result);
    return Object.freeze({ ready: true });
  } catch (error) {
    releaseWithError = error instanceof Error ? error : createReadinessError('READINESS_UNKNOWN');
    throw releaseWithError;
  } finally {
    client.release(releaseWithError);
  }
}

function createPostgresReadinessHandler({
  check = checkPostgresReadiness,
  logger = console,
} = {}) {
  if (typeof check !== 'function') {
    throw new TypeError('PostgreSQL就绪检查器必须是函数');
  }

  return async function postgresReadinessHandler(req, res) {
    try {
      await check();
      return res.status(200).json({ status: 'ready' });
    } catch (error) {
      logSafePostgresError(
        logger,
        '[postgres-readiness] check failed',
        error,
        'postgres_readiness_failed'
      );
      return res.status(503).json({ status: 'not_ready' });
    }
  };
}

module.exports = {
  DEFAULT_READINESS_TIMEOUT_MS,
  READINESS_SQL,
  checkPostgresReadiness,
  createPostgresReadinessHandler,
};
