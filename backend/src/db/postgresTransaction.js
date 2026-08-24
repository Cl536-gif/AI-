const { UserIdSchema } = require('../domain/userDataContract');
const { getPostgresPool } = require('./postgresPool');
const { parsePostgresPoolConfig } = require('./postgresPoolConfig');

const FORBIDDEN_QUERY_PREFIX = /^(begin|commit|rollback|savepoint|release|set|reset|discard)\b/i;
const FORBIDDEN_SET_CONFIG = /\bset_config\s*\(/i;
const SQL_COMMENT = /--|\/\*|\*\//;
const TRANSACTION_TIMEOUT_LIMITS = Object.freeze({
  statementTimeoutMs: Object.freeze({ min: 100, max: 120000 }),
  lockTimeoutMs: Object.freeze({ min: 100, max: 30000 }),
  idleTransactionTimeoutMs: Object.freeze({ min: 1000, max: 120000 }),
});

function assertCallback(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('数据库回调必须是函数');
  }
}

function assertBusinessQuery(text, values) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('业务查询必须提供非空SQL字符串');
  }
  if (!Array.isArray(values)) {
    throw new TypeError('业务查询必须显式提供参数数组');
  }
  const normalized = text.trim();
  if (normalized.includes(';')) {
    throw new Error('业务查询只允许单条SQL，不能包含分号');
  }
  if (SQL_COMMENT.test(normalized)) {
    throw new Error('业务查询不能包含SQL注释');
  }
  if (FORBIDDEN_QUERY_PREFIX.test(normalized) || FORBIDDEN_SET_CONFIG.test(normalized)) {
    throw new Error('业务查询不能控制事务、会话或数据库上下文');
  }
  return normalized;
}

function createScopedQueryClient(rawClient) {
  let active = true;
  const pendingQueries = new Set();
  const queryErrors = [];

  const scopedClient = Object.freeze({
    query(text, values) {
      if (!active) {
        return Promise.reject(new Error('数据库回调已结束，客户端不再可用'));
      }
      let normalized;
      try {
        normalized = assertBusinessQuery(text, values);
      } catch (error) {
        return Promise.reject(error);
      }

      let queryPromise;
      try {
        queryPromise = Promise.resolve(rawClient.query(normalized, values));
      } catch (error) {
        queryPromise = Promise.reject(error);
      }
      pendingQueries.add(queryPromise);
      queryPromise.then(
        () => pendingQueries.delete(queryPromise),
        (error) => {
          pendingQueries.delete(queryPromise);
          queryErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      );
      return queryPromise;
    },
  });

  return {
    client: scopedClient,
    deactivate() {
      active = false;
    },
    hasPendingQueries() {
      return pendingQueries.size > 0;
    },
    async waitForPendingQueries() {
      await Promise.allSettled([...pendingQueries]);
    },
    firstQueryError() {
      return queryErrors[0] || null;
    },
  };
}

function assertPool(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('需要支持 connect() 的PostgreSQL连接池');
  }
}

function assertRawClient(client) {
  if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
    throw new TypeError('连接池返回了无效的PostgreSQL客户端');
  }
}

function assertConnectedClient(client) {
  try {
    assertRawClient(client);
  } catch (error) {
    if (client && typeof client.release === 'function') client.release(error);
    throw error;
  }
}

async function executeScopedCallback(rawClient, callback) {
  const scope = createScopedQueryClient(rawClient);
  try {
    const result = await callback(scope.client);
    scope.deactivate();
    if (scope.hasPendingQueries()) {
      await scope.waitForPendingQueries();
      throw new Error('数据库回调结束时仍有未等待完成的查询');
    }
    const queryError = scope.firstQueryError();
    if (queryError) throw queryError;
    return result;
  } catch (error) {
    scope.deactivate();
    if (scope.hasPendingQueries()) await scope.waitForPendingQueries();
    throw error;
  }
}

function attachRollbackError(originalError, rollbackError) {
  const normalized = originalError instanceof Error
    ? originalError
    : new Error(String(originalError));
  Object.defineProperty(normalized, 'rollbackError', {
    value: rollbackError,
    enumerable: false,
    configurable: true,
  });
  return normalized;
}

function releaseClient(client, error) {
  if (error) client.release(error);
  else client.release();
}

async function withPostgresClient(callback, options = {}) {
  assertCallback(callback);
  const pool = options.pool || getPostgresPool();
  assertPool(pool);
  const client = await pool.connect();
  assertConnectedClient(client);

  let callbackError = null;
  try {
    return await executeScopedCallback(client, callback);
  } catch (error) {
    callbackError = error instanceof Error ? error : new Error(String(error));
    throw callbackError;
  } finally {
    try {
      releaseClient(client);
    } catch (releaseError) {
      if (!callbackError) throw releaseError;
      Object.defineProperty(callbackError, 'releaseError', {
        value: releaseError,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

function resolveTransactionConfig(options) {
  const config = options.config || parsePostgresPoolConfig(options.env || process.env);
  for (const [key, limits] of Object.entries(TRANSACTION_TIMEOUT_LIMITS)) {
    if (
      !Number.isSafeInteger(config[key])
      || config[key] < limits.min
      || config[key] > limits.max
    ) {
      throw new TypeError(
        `事务配置 ${key} 必须在 ${limits.min}—${limits.max} 之间`
      );
    }
  }
  return config;
}

async function withUserTransaction(userId, callback, options = {}) {
  assertCallback(callback);
  const normalizedUserId = UserIdSchema.parse(userId);
  const config = resolveTransactionConfig(options);
  const pool = options.pool || getPostgresPool();
  assertPool(pool);
  const client = await pool.connect();
  assertConnectedClient(client);

  let transactionStarted = false;
  let releaseWithError = null;
  let thrownError = null;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(
      "SELECT set_config('app.current_user_id', $1, true)",
      [normalizedUserId]
    );
    await client.query(`SET LOCAL statement_timeout = '${config.statementTimeoutMs}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${config.lockTimeoutMs}ms'`);
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = '${config.idleTransactionTimeoutMs}ms'`
    );

    const result = await executeScopedCallback(client, callback);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    thrownError = error instanceof Error ? error : new Error(String(error));
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
        transactionStarted = false;
      } catch (rollbackError) {
        releaseWithError = rollbackError;
        thrownError = attachRollbackError(thrownError, rollbackError);
      }
    } else {
      releaseWithError = thrownError;
    }
    throw thrownError;
  } finally {
    try {
      releaseClient(client, releaseWithError);
    } catch (releaseError) {
      if (!thrownError) throw releaseError;
      Object.defineProperty(thrownError, 'releaseError', {
        value: releaseError,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

module.exports = {
  withPostgresClient,
  withUserTransaction,
};
