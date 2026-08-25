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
  createVerificationConfig,
  normalizeErrorCode,
} = require('./src/db/postgresCloudVerification');
const {
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  resolveLangGraphCheckpointerPolicy,
} = require('./src/langgraph/checkpointerProvider');
const {
  POSTGRES_CHECKPOINTER_SCHEMA,
  POSTGRES_CHECKPOINTER_VERSION,
  createPostgresLangGraphCheckpointer,
} = require('./src/langgraph/postgresCheckpointer');
const {
  assertThreadScopeConfig,
  resolveInternalThreadId,
} = require('./src/langgraph/threadScope');

const CONFIRMATION = 'CONFIRMED_005E_SHARED_CHECKPOINTER_CLOUD';
const PHASES = new Set(['seed', 'resume', 'cleanup']);
const PUBLIC_THREAD_ID = '005e-shared-checkpointer-verification';
const SYNTHETIC_USER_ID = 'anon:005e_shared_checkpointer_verifier';
const OTHER_SYNTHETIC_USER_ID = 'anon:005e_shared_checkpointer_other';

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function assertCondition(condition, code) {
  if (!condition) fail(code);
}

function assert005eCloudEnvironment(env = process.env, phase = process.argv[2]) {
  if (String(env.RUN_005E_SHARED_CHECKPOINTER_VERIFY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED', '005e共享checkpointer云验证需要独立显式确认');
  }
  if (!PHASES.has(phase)) fail('VERIFY_PHASE_INVALID');
  if (String(env.USER_STORE_ADAPTER || '').trim().toLowerCase() !== 'sqlite') {
    fail('USER_STORE_MUST_REMAIN_SQLITE');
  }

  const policy = resolveLangGraphCheckpointerPolicy({ env });
  assertCondition(policy.backend === 'postgres' && policy.shared, 'SHARED_POLICY_REQUIRED');
  assertThreadScopeConfig(env);
  const config = createVerificationConfig(assertCloudVerificationEnvironment({
    ...env,
    RUN_003D_CLOUD_VERIFY: CLOUD_VERIFY_CONFIRMATION,
  }));
  return Object.freeze({ phase, policy, config });
}

function createGraph(checkpointer) {
  const CounterState = Annotation.Root({
    count: Annotation({
      reducer: (left, right) => left + right,
      default: () => 0,
    }),
  });
  return new StateGraph(CounterState)
    .addNode('increment', () => ({ count: 1 }))
    .addEdge(START, 'increment')
    .addEdge('increment', END)
    .compile({ checkpointer });
}

async function assertSchemaReady(pool) {
  const result = await pool.query({
    text: [
      'SELECT',
      '  to_regclass($1) IS NOT NULL AS migrations_ready,',
      '  to_regclass($2) IS NOT NULL AS checkpoints_ready,',
      '  to_regclass($3) IS NOT NULL AS blobs_ready,',
      '  to_regclass($4) IS NOT NULL AS writes_ready',
    ].join('\n'),
    values: [
      `${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoint_migrations`,
      `${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoints`,
      `${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoint_blobs`,
      `${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoint_writes`,
    ],
  });
  const row = result.rows[0];
  assertCondition(
    row?.migrations_ready
      && row.checkpoints_ready
      && row.blobs_ready
      && row.writes_ready,
    'CP_SCHEMA_NOT_READY'
  );

  const versions = await pool.query(
    `SELECT array_agg(v ORDER BY v) AS versions
       FROM ${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoint_migrations`
  );
  assertCondition(
    JSON.stringify(versions.rows[0]?.versions) === JSON.stringify([0, 1, 2, 3, 4]),
    'CP_MIGRATION_VERSION_MISMATCH'
  );
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

async function runPhase({ phase, pool, checkpointer, policy, env = process.env }) {
  const internalThreadId = resolveInternalThreadId({
    publicThreadId: PUBLIC_THREAD_ID,
    userId: SYNTHETIC_USER_ID,
    checkpointerPolicy: policy,
    env,
  });
  const otherInternalThreadId = resolveInternalThreadId({
    publicThreadId: PUBLIC_THREAD_ID,
    userId: OTHER_SYNTHETIC_USER_ID,
    checkpointerPolicy: policy,
    env,
  });
  const config = { configurable: { thread_id: internalThreadId } };

  if (phase === 'cleanup') {
    await checkpointer.deleteThread(internalThreadId);
    await checkpointer.deleteThread(otherInternalThreadId);
    const remaining = await countStoredKeys(pool, [
      internalThreadId,
      otherInternalThreadId,
      PUBLIC_THREAD_ID,
      SYNTHETIC_USER_ID,
      OTHER_SYNTHETIC_USER_ID,
    ]);
    assertCondition(
      remaining.checkpoints === 0 && remaining.blobs === 0 && remaining.writes === 0,
      'CP_CLEANUP_NOT_PROVEN'
    );
    return Object.freeze({ phase, cleanup: 'PASS', remainingRows: 0 });
  }

  const graph = createGraph(checkpointer);
  const existing = await checkpointer.getTuple(config);
  if (phase === 'seed') {
    assertCondition(existing === undefined, 'CP_SEED_PREEXISTING_STATE');
    const result = await graph.invoke({ count: 1 }, config);
    assertCondition(result.count === 2, 'CP_SEED_STATE_MISMATCH');
    const stored = await checkpointer.getTuple(config);
    assertCondition(Boolean(stored), 'CP_SEED_NOT_PERSISTED');
    const rawMatches = await countStoredKeys(pool, [PUBLIC_THREAD_ID, SYNTHETIC_USER_ID]);
    assertCondition(
      rawMatches.checkpoints === 0 && rawMatches.blobs === 0 && rawMatches.writes === 0,
      'RAW_IDENTIFIERS_STORED'
    );
    return Object.freeze({ phase, count: 2, persisted: true, rawIdentifiersStored: false });
  }

  assertCondition(Boolean(existing), 'CP_RESUME_STATE_MISSING');
  const result = await graph.invoke({ count: 1 }, config);
  assertCondition(result.count === 4, 'CP_RESUME_STATE_MISMATCH');
  const crossIdentity = await checkpointer.getTuple({
    configurable: { thread_id: otherInternalThreadId },
  });
  assertCondition(crossIdentity === undefined, 'CP_CROSS_IDENTITY_VISIBLE');
  return Object.freeze({
    phase,
    count: 4,
    previousProcessStateLoaded: true,
    crossIdentityVisible: false,
  });
}

async function run(phase = process.argv[2]) {
  const { policy, config } = assert005eCloudEnvironment(process.env, phase);
  const pool = createPostgresPool({ config });
  try {
    await checkPostgresReadiness({ pool });
    await assertSchemaReady(pool);
    const checkpointer = createPostgresLangGraphCheckpointer({
      pool,
      PostgresSaverClass: PostgresSaver,
    });
    const result = await runPhase({
      phase,
      pool,
      checkpointer,
      policy,
    });
    console.log(JSON.stringify({
      batch: '005e-shared-checkpointer-cloud',
      status: 'PASS',
      processPid: process.pid,
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
      batch: '005e-shared-checkpointer-cloud',
      status: 'FAIL',
      processPid: process.pid,
      errorCode: normalizeErrorCode(error, 'CONFIGURATION_ERROR'),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  OTHER_SYNTHETIC_USER_ID,
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  PUBLIC_THREAD_ID,
  SYNTHETIC_USER_ID,
  assert005eCloudEnvironment,
  createGraph,
  run,
  runPhase,
};
