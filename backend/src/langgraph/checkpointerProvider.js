const { MemorySaver } = require('@langchain/langgraph');
const {
  SINGLE_INSTANCE_CANARY_MODE,
  assertTencentPostgresCutoverAllowed,
} = require('../stores/tencentPostgresCutoverGate');

const MEMORY_CHECKPOINTER = 'memory';
const POSTGRES_CHECKPOINTER = 'postgres';

function createCheckpointerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveLangGraphCheckpointerPolicy({ env = process.env } = {}) {
  const userStoreAdapter = normalize(env.USER_STORE_ADAPTER) || 'sqlite';
  const configuredBackend = normalize(env.LANGGRAPH_CHECKPOINTER_BACKEND);
  const backend = configuredBackend || MEMORY_CHECKPOINTER;

  if (![MEMORY_CHECKPOINTER, POSTGRES_CHECKPOINTER].includes(backend)) {
    throw createCheckpointerError(
      'LANGGRAPH_CHECKPOINTER_BACKEND_UNSUPPORTED',
      `不支持的LangGraph checkpointer：${backend}`
    );
  }

  if (backend === POSTGRES_CHECKPOINTER) {
    return Object.freeze({
      backend,
      userStoreAdapter,
      shared: true,
      productionReady: false,
    });
  }

  if (userStoreAdapter !== 'tencent-postgres') {
    return Object.freeze({
      backend,
      userStoreAdapter,
      shared: false,
      productionReady: false,
    });
  }

  const requestedCutoverMode = normalize(env.TENCENT_PG_CUTOVER_MODE);
  if (requestedCutoverMode !== SINGLE_INSTANCE_CANARY_MODE) {
    throw createCheckpointerError(
      'LANGGRAPH_SHARED_CHECKPOINTER_REQUIRED',
      '多实例或全量PostgreSQL模式必须使用共享LangGraph checkpointer'
    );
  }
  const cutover = assertTencentPostgresCutoverAllowed({ env });

  return Object.freeze({
    backend,
    userStoreAdapter,
    cutoverMode: cutover.mode,
    maxInstances: cutover.maxInstances,
    shared: false,
    productionReady: false,
  });
}

function createLangGraphCheckpointer({
  env = process.env,
  createMemorySaver = () => new MemorySaver(),
  createPostgresSaver,
} = {}) {
  const policy = resolveLangGraphCheckpointerPolicy({ env });

  if (policy.backend === MEMORY_CHECKPOINTER) {
    return Object.freeze({
      checkpointer: createMemorySaver(),
      policy,
    });
  }

  if (typeof createPostgresSaver !== 'function') {
    throw createCheckpointerError(
      'LANGGRAPH_POSTGRES_CHECKPOINTER_NOT_IMPLEMENTED',
      'PostgreSQL LangGraph checkpointer尚未安装和初始化，拒绝启动'
    );
  }

  return Object.freeze({
    checkpointer: createPostgresSaver(),
    policy,
  });
}

module.exports = {
  MEMORY_CHECKPOINTER,
  POSTGRES_CHECKPOINTER,
  resolveLangGraphCheckpointerPolicy,
  createLangGraphCheckpointer,
};
