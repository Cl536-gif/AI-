const assert = require('assert');
const { MemorySaver } = require('@langchain/langgraph');
const {
  CONFIRMATION,
  DEDICATED_SERVICE_CONFIRMATION,
  assert005gCloudEnvironment,
  assertLinearCheckpointChain,
  runPhase,
} = require('./manual-test-langgraph-postgres-concurrency-cloud');
const {
  deriveAdvisoryLockKeys,
  withPostgresThreadAdvisoryLock,
} = require('./src/langgraph/postgresThreadAdvisoryLock');

const validEnv = {
  RUN_005G_CONCURRENCY_VERIFY: CONFIRMATION,
  RUN_005G_DEDICATED_SERVICE: DEDICATED_SERVICE_CONFIRMATION,
  USER_STORE_ADAPTER: 'sqlite',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'memory',
  LANGGRAPH_CONCURRENCY_CANARY_DECLARED_INSTANCES: '2',
  LANGGRAPH_CONCURRENCY_CANARY_RUN_ID: '005g-local-guard-01',
  LANGGRAPH_THREAD_HMAC_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  HOSTNAME: '005g-local-instance-a',
  TENCENT_PG_HOST: '10.0.0.8',
  TENCENT_PG_PORT: '5432',
  TENCENT_PG_DATABASE: 'diet_secretary',
  TENCENT_PG_USER: 'diet_app',
  TENCENT_PG_PASSWORD: 'test-only-password',
  TENCENT_PG_SSL_MODE: 'disable',
  TENCENT_PG_POOL_MAX: '2',
  TENCENT_PG_IDLE_TIMEOUT_MS: '30000',
  TENCENT_PG_CONNECT_TIMEOUT_MS: '5000',
  TENCENT_PG_STATEMENT_TIMEOUT_MS: '10000',
  TENCENT_PG_LOCK_TIMEOUT_MS: '3000',
  TENCENT_PG_IDLE_TX_TIMEOUT_MS: '15000',
};

const verified = assert005gCloudEnvironment(validEnv, 'seed');
assert.strictEqual(verified.config.poolMax, 2);
assert.deepStrictEqual(deriveAdvisoryLockKeys('same-thread'), deriveAdvisoryLockKeys('same-thread'));
assert.notDeepStrictEqual(deriveAdvisoryLockKeys('same-thread'), deriveAdvisoryLockKeys('other-thread'));

function expectCode(env, phase, code) {
  assert.throws(
    () => assert005gCloudEnvironment(env, phase),
    (error) => error?.code === code
  );
}

expectCode({ ...validEnv, RUN_005G_CONCURRENCY_VERIFY: '' }, 'seed', 'VERIFY_CONFIRMATION_REQUIRED');
expectCode({ ...validEnv, RUN_005G_DEDICATED_SERVICE: '' }, 'seed', 'DEDICATED_SERVICE_REQUIRED');
expectCode({ ...validEnv, USER_STORE_ADAPTER: 'tencent-postgres' }, 'seed', 'USER_STORE_MUST_REMAIN_SQLITE');
expectCode({ ...validEnv, LANGGRAPH_CHECKPOINTER_BACKEND: 'postgres' }, 'seed', 'RUNTIME_CP_MUST_REMAIN_MEMORY');
expectCode({ ...validEnv, LANGGRAPH_CONCURRENCY_CANARY_DECLARED_INSTANCES: '1' }, 'seed', 'DUAL_INSTANCE_REQUIRED');
expectCode({ ...validEnv, TENCENT_PG_POOL_MAX: '1' }, 'seed', 'CP_POOL_BUDGET_REQUIRED');
expectCode(validEnv, 'unknown', 'VERIFY_PHASE_INVALID');

const linearTuples = [
  { config: { configurable: { checkpoint_id: '3' } }, parentConfig: { configurable: { checkpoint_id: '2' } } },
  { config: { configurable: { checkpoint_id: '2' } }, parentConfig: { configurable: { checkpoint_id: '1' } } },
  { config: { configurable: { checkpoint_id: '1' } } },
];
assert.deepStrictEqual(assertLinearCheckpointChain(linearTuples), {
  checkpointCount: 3,
  branchCount: 0,
});
assert.throws(
  () => assertLinearCheckpointChain([
    ...linearTuples,
    { config: { configurable: { checkpoint_id: '4' } }, parentConfig: { configurable: { checkpoint_id: '2' } } },
  ]),
  (error) => error?.code === 'CP_BRANCH_DETECTED'
);

function createLockClient(acquireResults, releaseResult = true) {
  const calls = [];
  const client = {
    query: async ({ text }) => {
      calls.push(text);
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: acquireResults.shift() ?? false }] };
      }
      return { rows: [{ released: releaseResult }] };
    },
    release: (error) => calls.push(error ? 'release-error' : 'release-ok'),
  };
  return { calls, client };
}

async function testLockLifecycle() {
  const { calls, client } = createLockClient([true]);
  const result = await withPostgresThreadAdvisoryLock({
    pool: { connect: async () => client },
    scope: '005g-lock-lifecycle',
    work: async ({ waitMs }) => ({ waitMs, worked: true }),
  });
  assert.strictEqual(result.worked, true);
  assert.deepStrictEqual(calls, [
    'SELECT pg_try_advisory_lock($1, $2) AS acquired',
    'SELECT pg_advisory_unlock($1, $2) AS released',
    'release-ok',
  ]);
}

async function testLockPollingAndTimeout() {
  let clock = 0;
  const polled = createLockClient([false, false, true]);
  const result = await withPostgresThreadAdvisoryLock({
    pool: { connect: async () => polled.client },
    scope: '005g-lock-polling',
    timeoutMs: 500,
    pollMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    work: async ({ waitMs }) => waitMs,
  });
  assert.strictEqual(result, 200);

  clock = 0;
  const timedOut = createLockClient([false, false, false, false, false, false]);
  await assert.rejects(
    withPostgresThreadAdvisoryLock({
      pool: { connect: async () => timedOut.client },
      scope: '005g-lock-timeout',
      timeoutMs: 500,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      work: async () => undefined,
    }),
    (error) => error?.code === 'THREAD_LOCK_TIMEOUT'
  );
  assert.strictEqual(timedOut.calls.at(-1), 'release-ok');
}

async function testLockReleaseFailure() {
  const { calls, client } = createLockClient([true], false);
  await assert.rejects(
    withPostgresThreadAdvisoryLock({
      pool: { connect: async () => client },
      scope: '005g-lock-release-failure',
      work: async () => 'done',
    }),
    (error) => error?.code === 'THREAD_LOCK_RELEASE_FAILED'
  );
  assert.strictEqual(calls.at(-1), 'release-error');
}

async function testLocalEndToEnd() {
  const checkpointer = new MemorySaver();
  const pool = {
    query: async () => ({ rows: [{ checkpoints: 0, blobs: 0, writes: 0 }] }),
  };
  const common = {
    runId: '005g-local-end-to-end',
    pool,
    checkpointer,
    env: validEnv,
  };
  const immediateLock = ({ work }) => work({ waitMs: 0 });
  const waitedLock = ({ work }) => work({ waitMs: 600 });
  assert.strictEqual((await runPhase({ ...common, phase: 'seed', instanceFingerprint: 'seed' })).count, 2);
  assert.strictEqual((await runPhase({
    ...common,
    phase: 'contender-a',
    instanceFingerprint: 'instance-a',
    withLock: immediateLock,
    contenderOptions: { holdMs: 0 },
  })).count, 4);
  assert.strictEqual((await runPhase({
    ...common,
    phase: 'contender-b',
    instanceFingerprint: 'instance-b',
    withLock: waitedLock,
  })).count, 6);
  assert.strictEqual((await runPhase({
    ...common,
    phase: 'replay-a',
    instanceFingerprint: 'instance-a',
    withLock: immediateLock,
  })).checkpointUnchanged, true);
  const verifiedResult = await runPhase({
    ...common,
    phase: 'verify',
    instanceFingerprint: 'verify',
  });
  assert.strictEqual(verifiedResult.branchCount, 0);
  assert.strictEqual(verifiedResult.operationsApplied, 2);
  assert.strictEqual((await runPhase({
    ...common,
    phase: 'cleanup',
    instanceFingerprint: 'cleanup',
  })).remainingRows, 0);
}

Promise.all([
  testLockLifecycle(),
  testLockPollingAndTimeout(),
  testLockReleaseFailure(),
  testLocalEndToEnd(),
])
  .then(() => console.log(JSON.stringify({
    batch: '005g-concurrent-checkpointer-cloud',
    check: 'local_cloud_guard',
    status: 'PASS',
    dedicatedServiceRequired: true,
    userStoreRemainsSqlite: true,
    runtimeCheckpointerRemainsMemory: true,
    declaredInstancesRequired: 2,
    perInstancePoolBudget: 2,
    deterministicLockKeys: true,
    linearChainRequired: true,
    branchDetectionRequired: true,
    networkUsed: false,
  })))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
