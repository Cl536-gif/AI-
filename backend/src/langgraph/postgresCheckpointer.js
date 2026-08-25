const { getPostgresPool } = require('../db/postgresPool');

const POSTGRES_CHECKPOINTER_PACKAGE = '@langchain/langgraph-checkpoint-postgres';
const POSTGRES_CHECKPOINTER_VERSION = '1.0.4';
const POSTGRES_CHECKPOINTER_SCHEMA = 'langgraph_checkpoint';

function createPostgresCheckpointerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function loadPostgresSaver() {
  try {
    const { PostgresSaver } = require(POSTGRES_CHECKPOINTER_PACKAGE);
    return PostgresSaver;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      throw createPostgresCheckpointerError(
        'LANGGRAPH_POSTGRES_CHECKPOINTER_DEPENDENCY_MISSING',
        `缺少固定依赖 ${POSTGRES_CHECKPOINTER_PACKAGE}@${POSTGRES_CHECKPOINTER_VERSION}`
      );
    }
    throw error;
  }
}

function assertPool(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw createPostgresCheckpointerError(
      'LANGGRAPH_POSTGRES_CHECKPOINTER_POOL_INVALID',
      'LangGraph PostgreSQL checkpointer需要有效连接池'
    );
  }
}

function assertSaver(saver) {
  const requiredMethods = ['getTuple', 'list', 'put', 'putWrites', 'deleteThread'];
  if (!saver || requiredMethods.some((method) => typeof saver[method] !== 'function')) {
    throw createPostgresCheckpointerError(
      'LANGGRAPH_POSTGRES_CHECKPOINTER_INVALID',
      'LangGraph PostgreSQL checkpointer接口不完整'
    );
  }
}

function createPostgresLangGraphCheckpointer({
  pool = getPostgresPool(),
  PostgresSaverClass = loadPostgresSaver(),
} = {}) {
  assertPool(pool);
  if (typeof PostgresSaverClass !== 'function') {
    throw createPostgresCheckpointerError(
      'LANGGRAPH_POSTGRES_CHECKPOINTER_CLASS_INVALID',
      'PostgresSaver必须是可构造类型'
    );
  }

  const saver = new PostgresSaverClass(pool, undefined, {
    schema: POSTGRES_CHECKPOINTER_SCHEMA,
  });
  assertSaver(saver);
  return saver;
}

module.exports = {
  POSTGRES_CHECKPOINTER_PACKAGE,
  POSTGRES_CHECKPOINTER_VERSION,
  POSTGRES_CHECKPOINTER_SCHEMA,
  createPostgresLangGraphCheckpointer,
};
