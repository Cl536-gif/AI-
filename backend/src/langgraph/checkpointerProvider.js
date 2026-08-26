const { MemorySaver } = require('@langchain/langgraph');
const {
  DUAL_INSTANCE_HTTP_CANARY_MODE,
  SINGLE_INSTANCE_CANARY_MODE,
  assertTencentPostgresCutoverAllowed,
} = require('../stores/tencentPostgresCutoverGate');

const MEMORY_CHECKPOINTER = 'memory';
const POSTGRES_CHECKPOINTER = 'postgres';
const POSTGRES_CHECKPOINTER_CONFIRMATION = 'postgres-shared-checkpointer';
const POSTGRES_CHECKPOINTER_CANARY_MODE = 'single_instance_canary';
const POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE = 'dual_instance_http_canary';
const POSTGRES_THREAD_LOCK_CONFIRMATION = 'postgres-thread-lock-http-canary';

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
    const confirmation = String(env.LANGGRAPH_CHECKPOINTER_CONFIRM || '').trim();
    if (confirmation !== POSTGRES_CHECKPOINTER_CONFIRMATION) {
      throw createCheckpointerError(
        'LANGGRAPH_POSTGRES_CHECKPOINTER_CONFIRMATION_REQUIRED',
        '共享PostgreSQL checkpointer需要独立显式确认'
      );
    }
    const {
      POSTGRES_CHECKPOINTER_VERSION,
    } = require('./postgresCheckpointer');
    if (String(env.LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION || '').trim()
        !== POSTGRES_CHECKPOINTER_VERSION) {
      throw createCheckpointerError(
        'LANGGRAPH_POSTGRES_CHECKPOINTER_SCHEMA_VERSION_MISMATCH',
        '共享PostgreSQL checkpointer schema版本未确认或不匹配'
      );
    }
    const mode = normalize(env.LANGGRAPH_CHECKPOINTER_MODE);
    if (![POSTGRES_CHECKPOINTER_CANARY_MODE, POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE].includes(mode)) {
      throw createCheckpointerError(
        'LANGGRAPH_CHECKPOINTER_MODE_REQUIRED',
        '共享PostgreSQL checkpointer首次验证必须使用单实例canary模式'
      );
    }
    const expectedInstances = mode === POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE ? 2 : 1;
    if (String(env.LANGGRAPH_CHECKPOINTER_MAX_INSTANCES || '').trim() !== String(expectedInstances)) {
      throw createCheckpointerError(
        'LANGGRAPH_CHECKPOINTER_SCOPE_INVALID',
        `共享PostgreSQL checkpointer当前模式必须声明实例上限为${expectedInstances}`
      );
    }
    const httpCanary = mode === POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE;
    if (httpCanary) {
      if (userStoreAdapter !== 'tencent-postgres') {
        throw createCheckpointerError(
          'LANGGRAPH_HTTP_CANARY_POSTGRES_STORE_REQUIRED',
          '双实例HTTP灰度必须使用共享PostgreSQL UserStore'
        );
      }
      if (String(env.LANGGRAPH_THREAD_LOCK_CONFIRM || '').trim()
          !== POSTGRES_THREAD_LOCK_CONFIRMATION) {
        throw createCheckpointerError(
          'LANGGRAPH_HTTP_CANARY_LOCK_CONFIRMATION_REQUIRED',
          '双实例HTTP灰度需要独立确认同thread锁'
        );
      }
      const cutover = assertTencentPostgresCutoverAllowed({ env });
      if (cutover.mode !== DUAL_INSTANCE_HTTP_CANARY_MODE) {
        throw createCheckpointerError(
          'LANGGRAPH_HTTP_CANARY_CUTOVER_MODE_MISMATCH',
          'UserStore与checkpointer灰度模式不一致'
        );
      }
    }
    return Object.freeze({
      backend,
      userStoreAdapter,
      schemaVersion: POSTGRES_CHECKPOINTER_VERSION,
      mode,
      maxInstances: expectedInstances,
      shared: true,
      requiresThreadLock: httpCanary,
      httpCanary,
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
  createPostgresSaver = () => {
    const {
      createPostgresLangGraphCheckpointer,
    } = require('./postgresCheckpointer');
    return createPostgresLangGraphCheckpointer();
  },
} = {}) {
  const policy = resolveLangGraphCheckpointerPolicy({ env });

  if (policy.backend === MEMORY_CHECKPOINTER) {
    return Object.freeze({
      checkpointer: createMemorySaver(),
      policy,
    });
  }

  const { assertThreadScopeConfig } = require('./threadScope');
  assertThreadScopeConfig(env);

  return Object.freeze({
    checkpointer: createPostgresSaver(),
    policy,
  });
}

module.exports = {
  MEMORY_CHECKPOINTER,
  POSTGRES_CHECKPOINTER,
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  POSTGRES_CHECKPOINTER_CANARY_MODE,
  POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  POSTGRES_THREAD_LOCK_CONFIRMATION,
  resolveLangGraphCheckpointerPolicy,
  createLangGraphCheckpointer,
};
