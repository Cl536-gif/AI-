const assert = require('assert');
const {
  POSTGRES_CHECKPOINTER_PACKAGE,
  POSTGRES_CHECKPOINTER_VERSION,
  POSTGRES_CHECKPOINTER_SCHEMA,
  createPostgresLangGraphCheckpointer,
} = require('./src/langgraph/postgresCheckpointer');
const { resolveInternalThreadId } = require('./src/langgraph/threadScope');

let setupCalls = 0;

class FakePostgresSaver {
  constructor(pool, serde, options) {
    this.pool = pool;
    this.serde = serde;
    this.options = options;
  }

  getTuple() {}
  async *list() {}
  put() {}
  putWrites() {}
  deleteThread() {}
  setup() { setupCalls += 1; }
}

const pool = { query() {}, connect() {} };
const saver = createPostgresLangGraphCheckpointer({
  pool,
  PostgresSaverClass: FakePostgresSaver,
});
assert.strictEqual(saver.pool, pool);
assert.strictEqual(saver.serde, undefined);
assert.deepStrictEqual(saver.options, { schema: POSTGRES_CHECKPOINTER_SCHEMA });
assert.strictEqual(setupCalls, 0);

const policy = { backend: 'postgres' };
const env = { LANGGRAPH_THREAD_HMAC_SECRET: 'a'.repeat(32) };
const first = resolveInternalThreadId({
  publicThreadId: 'thread-a',
  userId: 'anon:user-a',
  checkpointerPolicy: policy,
  env,
});
const repeated = resolveInternalThreadId({
  publicThreadId: 'thread-a',
  userId: 'anon:user-a',
  checkpointerPolicy: policy,
  env,
});
const otherUser = resolveInternalThreadId({
  publicThreadId: 'thread-a',
  userId: 'anon:user-b',
  checkpointerPolicy: policy,
  env,
});
assert.strictEqual(first, repeated);
assert.notStrictEqual(first, otherUser);
assert(/^v1:[a-f0-9]{64}$/.test(first));
assert(!first.includes('thread-a'));
assert(!first.includes('anon:user-a'));
assert.throws(
  () => resolveInternalThreadId({
    publicThreadId: 'thread-a',
    userId: null,
    checkpointerPolicy: policy,
    env,
  }),
  (error) => error?.code === 'LANGGRAPH_THREAD_IDENTITY_REQUIRED'
);
assert.throws(
  () => resolveInternalThreadId({
    publicThreadId: 'thread-a',
    userId: 'anon:user-a',
    checkpointerPolicy: policy,
    env: { LANGGRAPH_THREAD_HMAC_SECRET: 'short' },
  }),
  (error) => error?.code === 'LANGGRAPH_THREAD_SCOPE_SECRET_INVALID'
);
assert.strictEqual(
  resolveInternalThreadId({
    publicThreadId: 'memory-thread',
    userId: null,
    checkpointerPolicy: { backend: 'memory' },
    env: {},
  }),
  'memory-thread'
);

console.log(JSON.stringify({
  batch: '005e-langgraph-postgres-checkpointer',
  status: 'PASS',
  package: POSTGRES_CHECKPOINTER_PACKAGE,
  pinnedVersion: POSTGRES_CHECKPOINTER_VERSION,
  existingPoolReused: true,
  runtimeSetupForbidden: true,
  identityScopedThreadKey: true,
  rawIdentifiersExcluded: true,
}));
