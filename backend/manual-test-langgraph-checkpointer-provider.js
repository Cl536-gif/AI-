const assert = require('assert');
const {
  MEMORY_CHECKPOINTER,
  POSTGRES_CHECKPOINTER,
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  resolveLangGraphCheckpointerPolicy,
  createLangGraphCheckpointer,
} = require('./src/langgraph/checkpointerProvider');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

const sqliteDefault = resolveLangGraphCheckpointerPolicy({ env: {} });
assert.deepStrictEqual(sqliteDefault, {
  backend: MEMORY_CHECKPOINTER,
  userStoreAdapter: 'sqlite',
  shared: false,
  productionReady: false,
});

const canaryEnv = {
  USER_STORE_ADAPTER: 'tencent-postgres',
  TENCENT_PG_CUTOVER_MODE: 'single_instance_canary',
  TENCENT_PG_CUTOVER_CONFIRM: 'postgres-single-instance-canary',
  TENCENT_PG_CANARY_MAX_INSTANCES: '1',
  TENCENT_PG_POOL_MAX: '1',
};
const canaryPolicy = resolveLangGraphCheckpointerPolicy({ env: canaryEnv });
assert.strictEqual(canaryPolicy.backend, MEMORY_CHECKPOINTER);
assert.strictEqual(canaryPolicy.cutoverMode, 'single_instance_canary');
assert.strictEqual(canaryPolicy.maxInstances, 1);

expectCode(
  () => resolveLangGraphCheckpointerPolicy({
    env: { ...canaryEnv, TENCENT_PG_CANARY_MAX_INSTANCES: '2' },
  }),
  'POSTGRES_CANARY_SCOPE_INVALID'
);
expectCode(
  () => resolveLangGraphCheckpointerPolicy({
    env: {
      USER_STORE_ADAPTER: 'tencent-postgres',
      TENCENT_PG_CUTOVER_MODE: 'full',
      TENCENT_PG_CUTOVER_CONFIRM: 'postgres-full-cutover',
    },
  }),
  'LANGGRAPH_SHARED_CHECKPOINTER_REQUIRED'
);
expectCode(
  () => resolveLangGraphCheckpointerPolicy({
    env: { LANGGRAPH_CHECKPOINTER_BACKEND: 'unknown' },
  }),
  'LANGGRAPH_CHECKPOINTER_BACKEND_UNSUPPORTED'
);

const futurePostgresPolicy = resolveLangGraphCheckpointerPolicy({
  env: {
    LANGGRAPH_CHECKPOINTER_BACKEND: POSTGRES_CHECKPOINTER,
    LANGGRAPH_CHECKPOINTER_CONFIRM: POSTGRES_CHECKPOINTER_CONFIRMATION,
    LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION: '1.0.4',
  },
});
assert.strictEqual(futurePostgresPolicy.shared, true);
assert.strictEqual(futurePostgresPolicy.productionReady, false);
const postgresMarker = {};
const futurePostgres = createLangGraphCheckpointer({
  env: {
    LANGGRAPH_CHECKPOINTER_BACKEND: POSTGRES_CHECKPOINTER,
    LANGGRAPH_CHECKPOINTER_CONFIRM: POSTGRES_CHECKPOINTER_CONFIRMATION,
    LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION: '1.0.4',
    LANGGRAPH_THREAD_HMAC_SECRET: 'a'.repeat(32),
  },
  createPostgresSaver: () => postgresMarker,
});
assert.strictEqual(futurePostgres.checkpointer, postgresMarker);
assert.strictEqual(futurePostgres.policy.shared, true);
expectCode(
  () => resolveLangGraphCheckpointerPolicy({
    env: { LANGGRAPH_CHECKPOINTER_BACKEND: POSTGRES_CHECKPOINTER },
  }),
  'LANGGRAPH_POSTGRES_CHECKPOINTER_CONFIRMATION_REQUIRED'
);
expectCode(
  () => resolveLangGraphCheckpointerPolicy({
    env: {
      LANGGRAPH_CHECKPOINTER_BACKEND: POSTGRES_CHECKPOINTER,
      LANGGRAPH_CHECKPOINTER_CONFIRM: POSTGRES_CHECKPOINTER_CONFIRMATION,
      LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION: 'wrong',
    },
  }),
  'LANGGRAPH_POSTGRES_CHECKPOINTER_SCHEMA_VERSION_MISMATCH'
);
expectCode(
  () => createLangGraphCheckpointer({
    env: {
      LANGGRAPH_CHECKPOINTER_BACKEND: POSTGRES_CHECKPOINTER,
      LANGGRAPH_CHECKPOINTER_CONFIRM: POSTGRES_CHECKPOINTER_CONFIRMATION,
      LANGGRAPH_CHECKPOINTER_SCHEMA_VERSION: '1.0.4',
      LANGGRAPH_THREAD_HMAC_SECRET: 'short',
    },
    createPostgresSaver: () => postgresMarker,
  }),
  'LANGGRAPH_THREAD_SCOPE_SECRET_INVALID'
);

const marker = {};
const created = createLangGraphCheckpointer({
  env: {},
  createMemorySaver: () => marker,
});
assert.strictEqual(created.checkpointer, marker);
assert.strictEqual(created.policy.backend, MEMORY_CHECKPOINTER);

console.log(JSON.stringify({
  batch: '005e-langgraph-checkpointer-provider',
  status: 'PASS',
  sqliteDefaultUnchanged: true,
  singleInstanceCanaryMemoryAllowed: true,
  unsafeCanaryRejected: true,
  fullPostgresCannotUseMemory: true,
  postgresBackendRequiresConfirmationAndSchemaVersion: true,
  postgresBackendRequiresThreadScopeSecret: true,
}));
