const { Pool } = require('pg');
const { parsePostgresPoolConfig } = require('./postgresPoolConfig');
const { logSafePostgresError } = require('./postgresDiagnostics');

const APPLICATION_NAME = 'diet-secretary-backend';

let activePool = null;
let poolLifecycleState = 'open';
let closingPoolPromise = null;

function buildPoolOptions(config) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectTimeoutMs,
    application_name: APPLICATION_NAME,
    keepAlive: true,
    allowExitOnIdle: false,
  };
}

function createPostgresPool({
  env = process.env,
  config,
  PoolClass = Pool,
  logger = console,
} = {}) {
  if (typeof PoolClass !== 'function') {
    throw new TypeError('PoolClass 必须是可构造的连接池类型');
  }
  const resolvedConfig = config || parsePostgresPoolConfig(env);
  const pool = new PoolClass(buildPoolOptions(resolvedConfig));
  if (pool && typeof pool.on === 'function') {
    pool.on('error', (error) => {
      logSafePostgresError(
        logger,
        '[postgres-pool] idle client error',
        error,
        'postgres_pool_idle_client_error'
      );
    });
  }
  return pool;
}

function getPostgresPool(options = {}) {
  if (poolLifecycleState !== 'open') {
    throw new Error('PostgreSQL连接池正在关闭或已经关闭');
  }
  if (!activePool) activePool = createPostgresPool(options);
  return activePool;
}

function closePostgresPool() {
  if (closingPoolPromise) return closingPoolPromise;
  poolLifecycleState = 'closing';
  const poolToClose = activePool;
  activePool = null;
  closingPoolPromise = Promise.resolve()
    .then(() => {
      if (poolToClose && typeof poolToClose.end === 'function') return poolToClose.end();
      return undefined;
    })
    .finally(() => {
      poolLifecycleState = 'closed';
    });
  return closingPoolPromise;
}

function resetPostgresPoolForTests() {
  activePool = null;
  poolLifecycleState = 'open';
  closingPoolPromise = null;
}

module.exports = {
  APPLICATION_NAME,
  buildPoolOptions,
  closePostgresPool,
  createPostgresPool,
  getPostgresPool,
  resetPostgresPoolForTests,
};
