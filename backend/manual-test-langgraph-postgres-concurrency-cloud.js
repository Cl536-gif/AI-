const crypto = require('crypto');
const {
  Annotation,
  END,
  START,
  StateGraph,
} = require('@langchain/langgraph');
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres');
const { createPostgresPool } = require('./src/db/postgresPool');
const { checkPostgresReadiness } = require('./src/db/postgresReadiness');
const {
  CLOUD_VERIFY_CONFIRMATION,
  assertCloudVerificationEnvironment,
  normalizeErrorCode,
} = require('./src/db/postgresCloudVerification');
const {
  POSTGRES_CHECKPOINTER_SCHEMA,
  POSTGRES_CHECKPOINTER_VERSION,
  createPostgresLangGraphCheckpointer,
} = require('./src/langgraph/postgresCheckpointer');
const {
  assertThreadScopeConfig,
  resolveInternalThreadId,
} = require('./src/langgraph/threadScope');
const {
  withPostgresThreadAdvisoryLock,
} = require('./src/langgraph/postgresThreadAdvisoryLock');

const CONFIRMATION = 'CONFIRMED_005G_CONCURRENT_CHECKPOINTER_CLOUD';
const DEDICATED_SERVICE_CONFIRMATION = 'CONFIRMED_005G_DEDICATED_VALIDATION_SERVICE';
const PHASES = new Set(['seed', 'contender-a', 'contender-b', 'replay-a', 'verify', 'cleanup']);
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const SYNTHETIC_USER_ID = 'anon:005g_concurrency_verifier';
const OPERATION_A = 'operation-a';
const OPERATION_B = 'operation-b';

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function assertCondition(condition, code) {
  if (!condition) fail(code);
}

function resolveInstanceFingerprint(env = process.env) {
  const hostname = String(env.HOSTNAME || '').trim();
  assertCondition(hostname.length >= 3 && hostname.length <= 253, 'INSTANCE_HOSTNAME_REQUIRED');
  return crypto
    .createHmac('sha256', String(env.LANGGRAPH_THREAD_HMAC_SECRET || ''))
    .update(`005g-instance\0${hostname}`, 'utf8')
    .digest('hex');
}

function assert005gCloudEnvironment(env = process.env, phase = process.argv[2]) {
  if (String(env.RUN_005G_CONCURRENCY_VERIFY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.RUN_005G_DEDICATED_SERVICE || '').trim() !== DEDICATED_SERVICE_CONFIRMATION) {
    fail('DEDICATED_SERVICE_REQUIRED');
  }
  if (!PHASES.has(phase)) fail('VERIFY_PHASE_INVALID');
  if (String(env.USER_STORE_ADAPTER || '').trim().toLowerCase() !== 'sqlite') {
    fail('USER_STORE_MUST_REMAIN_SQLITE');
  }
  if (String(env.LANGGRAPH_CHECKPOINTER_BACKEND || '').trim().toLowerCase() !== 'memory') {
    fail('RUNTIME_CP_MUST_REMAIN_MEMORY');
  }
  if (String(env.LANGGRAPH_CONCURRENCY_CANARY_DECLARED_INSTANCES || '').trim() !== '2') {
    fail('DUAL_INSTANCE_REQUIRED');
  }
  if (String(env.TENCENT_PG_POOL_MAX || '').trim() !== '2') {
    fail('CP_POOL_BUDGET_REQUIRED');
  }
  const runId = String(env.LANGGRAPH_CONCURRENCY_CANARY_RUN_ID || '').trim().toLowerCase();
  if (!RUN_ID_PATTERN.test(runId)) fail('VERIFY_RUN_ID_INVALID');
  assertThreadScopeConfig(env);
  const instanceFingerprint = resolveInstanceFingerprint(env);
  const config = assertCloudVerificationEnvironment({
    ...env,
    RUN_003D_CLOUD_VERIFY: CLOUD_VERIFY_CONFIRMATION,
  });
  assertCondition(config.poolMax === 2, 'CP_POOL_BUDGET_REQUIRED');
  return Object.freeze({ phase, runId, instanceFingerprint, config });
}

function createGraph(checkpointer) {
  const State = Annotation.Root({
    count: Annotation({ reducer: (left, right) => left + right, default: () => 0 }),
    operations: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
    instanceFingerprints: Annotation({
      reducer: (left, right) => left.concat(right),
      default: () => [],
    }),
  });
  return new StateGraph(State)
    .addNode('increment', () => ({ count: 1 }))
    .addEdge(START, 'increment')
    .addEdge('increment', END)
    .compile({ checkpointer });
}

function resolveVerificationThread({ runId, env }) {
  const publicThreadId = `005g-concurrency-${runId}`;
  return Object.freeze({
    publicThreadId,
    internalThreadId: resolveInternalThreadId({
      publicThreadId,
      userId: SYNTHETIC_USER_ID,
      checkpointerPolicy: { backend: 'postgres' },
      env,
    }),
  });
}

async function listCheckpoints(checkpointer, config) {
  const tuples = [];
  for await (const tuple of checkpointer.list(config)) tuples.push(tuple);
  return tuples;
}

async function countStoredKeys(pool, keys) {
  const result = await pool.query({
    text: [
      'SELECT',
      `  (SELECT count(*)::int FROM ${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoints`,
      '    WHERE thread_id = ANY($1::text[])) AS checkpoints,',
      `  (SELECT count(*)::int FROM ${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoint_blobs`,
      '    WHERE thread_id = ANY($1::text[])) AS blobs,',
      `  (SELECT count(*)::int FROM ${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoint_writes`,
      '    WHERE thread_id = ANY($1::text[])) AS writes',
    ].join('\n'),
    values: [keys],
  });
  return result.rows[0];
}

function assertNoStoredKeys(row, code = 'RAW_IDENTIFIERS_STORED') {
  assertCondition(
    row?.checkpoints === 0 && row?.blobs === 0 && row?.writes === 0,
    code
  );
}

function assertLinearCheckpointChain(tuples) {
  assertCondition(tuples.length > 0, 'CP_CHAIN_EMPTY');
  const ids = new Set(tuples.map((tuple) => tuple.config.configurable?.checkpoint_id));
  const childrenByParent = new Map();
  let rootCount = 0;
  for (const tuple of tuples) {
    const parentId = tuple.parentConfig?.configurable?.checkpoint_id;
    if (!parentId) {
      rootCount += 1;
      continue;
    }
    assertCondition(ids.has(parentId), 'CP_CHAIN_PARENT_MISSING');
    const children = childrenByParent.get(parentId) || new Set();
    children.add(tuple.config.configurable?.checkpoint_id);
    childrenByParent.set(parentId, children);
  }
  assertCondition(rootCount === 1, 'CP_CHAIN_ROOT_INVALID');
  assertCondition(
    [...childrenByParent.values()].every((children) => children.size === 1),
    'CP_BRANCH_DETECTED'
  );
  return Object.freeze({ checkpointCount: tuples.length, branchCount: 0 });
}

async function runContender({
  role,
  internalThreadId,
  instanceFingerprint,
  pool,
  graph,
  checkpointer,
  withLock = withPostgresThreadAdvisoryLock,
  holdMs = 10000,
  minPeerWaitMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const operation = role === 'contender-a' ? OPERATION_A : OPERATION_B;
  const expectedBaseCount = role === 'contender-a' ? 2 : 4;
  const expectedResultCount = role === 'contender-a' ? 4 : 6;
  const config = { configurable: { thread_id: internalThreadId } };
  return withLock({
    pool,
    scope: internalThreadId,
    work: async ({ waitMs }) => {
      const existing = await checkpointer.getTuple(config);
      const beforeId = existing?.config?.configurable?.checkpoint_id;
      const state = existing?.checkpoint?.channel_values;
      if (state?.operations?.includes(operation)) {
        const after = await checkpointer.getTuple(config);
        assertCondition(
          after?.config?.configurable?.checkpoint_id === beforeId,
          'CP_REPLAY_WROTE_CHECKPOINT'
        );
        return Object.freeze({
          phase: role === 'contender-a' ? 'replay-a' : 'replay-b',
          count: state.count,
          replayed: true,
          operationAppliedOnce: true,
          checkpointUnchanged: true,
        });
      }
      assertCondition(state?.count === expectedBaseCount, 'CP_BASE_STATE_MISMATCH');
      if (role === 'contender-b') {
        assertCondition(waitMs >= minPeerWaitMs, 'CP_PEER_OVERLAP_NOT_PROVEN');
      } else if (holdMs > 0) {
        await sleep(holdMs);
      }
      const result = await graph.invoke({
        count: 1,
        operations: [operation],
        instanceFingerprints: [instanceFingerprint],
      }, config);
      assertCondition(result.count === expectedResultCount, 'CP_RESULT_MISMATCH');
      return Object.freeze({
        phase: role,
        count: result.count,
        lockAcquired: true,
        peerOverlapProven: role === 'contender-b' ? true : undefined,
        operationAppliedOnce: true,
      });
    },
  });
}

async function runPhase({
  phase,
  runId,
  instanceFingerprint,
  pool,
  checkpointer,
  env,
  contenderOptions = {},
  withLock = withPostgresThreadAdvisoryLock,
}) {
  const { publicThreadId, internalThreadId } = resolveVerificationThread({ runId, env });
  const config = { configurable: { thread_id: internalThreadId } };
  if (phase === 'cleanup') {
    await checkpointer.deleteThread(internalThreadId);
    const remaining = await countStoredKeys(pool, [
      internalThreadId,
      publicThreadId,
      SYNTHETIC_USER_ID,
      runId,
    ]);
    assertNoStoredKeys(remaining, 'CP_CLEANUP_NOT_PROVEN');
    return Object.freeze({ phase, cleanup: 'PASS', remainingRows: 0 });
  }

  const graph = createGraph(checkpointer);
  if (phase === 'seed') {
    assertCondition(await checkpointer.getTuple(config) === undefined, 'CP_SEED_PREEXISTING_STATE');
    const result = await graph.invoke({ count: 1 }, config);
    assertCondition(result.count === 2, 'CP_SEED_STATE_MISMATCH');
    const rawMatches = await countStoredKeys(pool, [publicThreadId, SYNTHETIC_USER_ID, runId]);
    assertNoStoredKeys(rawMatches);
    return Object.freeze({ phase, count: 2, persisted: true, rawIdentifiersStored: false });
  }
  if (phase === 'contender-a' || phase === 'contender-b') {
    return runContender({
      role: phase,
      internalThreadId,
      instanceFingerprint,
      pool,
      graph,
      checkpointer,
      withLock,
      ...contenderOptions,
    });
  }
  if (phase === 'replay-a') {
    const result = await runContender({
      role: 'contender-a',
      internalThreadId,
      instanceFingerprint,
      pool,
      graph,
      checkpointer,
      withLock,
      holdMs: 0,
    });
    assertCondition(result.replayed === true, 'CP_REPLAY_OPERATION_MISSING');
    assertCondition(result.count === 6, 'CP_REPLAY_BASE_MISMATCH');
    return result;
  }

  const latest = await checkpointer.getTuple(config);
  const state = latest?.checkpoint?.channel_values;
  assertCondition(state?.count === 6, 'CP_FINAL_STATE_MISMATCH');
  assertCondition(
    Array.isArray(state.operations)
      && state.operations.length === 2
      && JSON.stringify([...state.operations].sort())
      === JSON.stringify([OPERATION_A, OPERATION_B]),
    'CP_OPERATION_SET_MISMATCH'
  );
  assertCondition(
    Array.isArray(state.instanceFingerprints)
      && state.instanceFingerprints.length === 2
      && new Set(state.instanceFingerprints).size === 2,
    'CP_INSTANCE_SET_MISMATCH'
  );
  const rawMatches = await countStoredKeys(pool, [publicThreadId, SYNTHETIC_USER_ID, runId]);
  assertNoStoredKeys(rawMatches);
  const chain = assertLinearCheckpointChain(await listCheckpoints(checkpointer, config));
  return Object.freeze({
    phase,
    count: 6,
    operationsApplied: 2,
    distinctInstances: true,
    ...chain,
    rawIdentifiersStored: false,
  });
}

async function run(phase = process.argv[2]) {
  const verified = assert005gCloudEnvironment(process.env, phase);
  const pool = createPostgresPool({ config: verified.config });
  try {
    await checkPostgresReadiness({ pool });
    const checkpointer = createPostgresLangGraphCheckpointer({
      pool,
      PostgresSaverClass: PostgresSaver,
    });
    const result = await runPhase({
      ...verified,
      pool,
      checkpointer,
      env: process.env,
    });
    console.log(JSON.stringify({
      batch: '005g-concurrent-checkpointer-cloud',
      status: 'PASS',
      packageVersion: POSTGRES_CHECKPOINTER_VERSION,
      ...result,
    }));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      batch: '005g-concurrent-checkpointer-cloud',
      status: 'FAIL',
      errorCode: normalizeErrorCode(error, 'CONFIGURATION_ERROR'),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  DEDICATED_SERVICE_CONFIRMATION,
  OPERATION_A,
  OPERATION_B,
  assert005gCloudEnvironment,
  assertLinearCheckpointChain,
  countStoredKeys,
  createGraph,
  resolveVerificationThread,
  run,
  runContender,
  runPhase,
};
