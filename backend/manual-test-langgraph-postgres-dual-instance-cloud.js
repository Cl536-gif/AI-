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
  createVerificationConfig,
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

const CONFIRMATION = 'CONFIRMED_005F_DUAL_INSTANCE_CHECKPOINTER_CLOUD';
const DEDICATED_SERVICE_CONFIRMATION = 'CONFIRMED_005F_DEDICATED_VALIDATION_SERVICE';
const PHASES = new Set(['writer', 'reader', 'cleanup']);
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const SYNTHETIC_USER_ID = 'anon:005f_dual_instance_verifier';

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function assertCondition(condition, code) {
  if (!condition) fail(code);
}

function resolveInstanceFingerprint(env = process.env) {
  const hostname = String(env.HOSTNAME || '').trim();
  assertCondition(hostname.length >= 3 && hostname.length <= 253, 'INSTANCE_HOSTNAME_REQUIRED');
  const secret = String(env.LANGGRAPH_THREAD_HMAC_SECRET || '');
  return crypto
    .createHmac('sha256', secret)
    .update(`005f-instance\0${hostname}`, 'utf8')
    .digest('hex');
}

function assert005fCloudEnvironment(env = process.env, phase = process.argv[2]) {
  if (String(env.RUN_005F_DUAL_INSTANCE_VERIFY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.RUN_005F_DEDICATED_SERVICE || '').trim() !== DEDICATED_SERVICE_CONFIRMATION) {
    fail('DEDICATED_VALIDATION_SERVICE_REQUIRED');
  }
  if (!PHASES.has(phase)) fail('VERIFY_PHASE_INVALID');
  if (String(env.USER_STORE_ADAPTER || '').trim().toLowerCase() !== 'sqlite') {
    fail('USER_STORE_MUST_REMAIN_SQLITE');
  }
  if (String(env.LANGGRAPH_CHECKPOINTER_BACKEND || '').trim().toLowerCase() !== 'memory') {
    fail('RUNTIME_CHECKPOINTER_MUST_REMAIN_MEMORY');
  }
  if (String(env.LANGGRAPH_DUAL_INSTANCE_CANARY_DECLARED_INSTANCES || '').trim() !== '2') {
    fail('DUAL_INSTANCE_DECLARATION_REQUIRED');
  }
  const runId = String(env.LANGGRAPH_DUAL_INSTANCE_CANARY_RUN_ID || '').trim().toLowerCase();
  if (!RUN_ID_PATTERN.test(runId)) fail('VERIFY_RUN_ID_INVALID');

  assertThreadScopeConfig(env);
  const instanceFingerprint = resolveInstanceFingerprint(env);
  const config = createVerificationConfig(assertCloudVerificationEnvironment({
    ...env,
    RUN_003D_CLOUD_VERIFY: CLOUD_VERIFY_CONFIRMATION,
  }));
  return Object.freeze({ phase, runId, instanceFingerprint, config });
}

function createGraph(checkpointer) {
  const CounterState = Annotation.Root({
    count: Annotation({
      reducer: (left, right) => left + right,
      default: () => 0,
    }),
    instanceFingerprints: Annotation({
      reducer: (left, right) => left.concat(right),
      default: () => [],
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
    row?.migrations_ready && row.checkpoints_ready && row.blobs_ready && row.writes_ready,
    'CP_SCHEMA_NOT_READY'
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

function resolveVerificationThread({ runId, env }) {
  const publicThreadId = `005f-dual-instance-${runId}`;
  const checkpointerPolicy = { backend: 'postgres' };
  return Object.freeze({
    publicThreadId,
    internalThreadId: resolveInternalThreadId({
      publicThreadId,
      userId: SYNTHETIC_USER_ID,
      checkpointerPolicy,
      env,
    }),
  });
}

function assertReaderPrecondition(existing, instanceFingerprint) {
  const values = existing?.checkpoint?.channel_values;
  assertCondition(values && values.count === 2, 'CP_READER_BASE_STATE_MISMATCH');
  assertCondition(
    Array.isArray(values.instanceFingerprints)
      && values.instanceFingerprints.length === 1,
    'CP_WRITER_INSTANCE_MARKER_MISMATCH'
  );
  assertCondition(
    values.instanceFingerprints[0] !== instanceFingerprint,
    'CP_INSTANCE_NOT_DISTINCT'
  );
  return values;
}

async function runPhase({ phase, runId, instanceFingerprint, pool, checkpointer, env }) {
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
    assertCondition(
      remaining.checkpoints === 0 && remaining.blobs === 0 && remaining.writes === 0,
      'CP_CLEANUP_NOT_PROVEN'
    );
    return Object.freeze({ phase, cleanup: 'PASS', remainingRows: 0 });
  }

  const graph = createGraph(checkpointer);
  const existing = await checkpointer.getTuple(config);
  if (phase === 'writer') {
    assertCondition(existing === undefined, 'CP_WRITER_PREEXISTING_STATE');
    const result = await graph.invoke({
      count: 1,
      instanceFingerprints: [instanceFingerprint],
    }, config);
    assertCondition(result.count === 2, 'CP_WRITER_STATE_MISMATCH');
    assertCondition(
      result.instanceFingerprints.length === 1
        && result.instanceFingerprints[0] === instanceFingerprint,
      'CP_WRITER_INSTANCE_MARKER_MISMATCH'
    );
    const rawMatches = await countStoredKeys(pool, [publicThreadId, SYNTHETIC_USER_ID, runId]);
    assertCondition(
      rawMatches.checkpoints === 0 && rawMatches.blobs === 0 && rawMatches.writes === 0,
      'RAW_IDENTIFIERS_STORED'
    );
    return Object.freeze({ phase, count: 2, persisted: true, rawIdentifiersStored: false });
  }

  assertCondition(Boolean(existing), 'CP_READER_STATE_MISSING');
  // 必须在invoke之前证明reader来自不同实例；否则失败本身也会写入新checkpoint。
  assertReaderPrecondition(existing, instanceFingerprint);
  const result = await graph.invoke({
    count: 1,
    instanceFingerprints: [instanceFingerprint],
  }, config);
  const uniqueInstances = new Set(result.instanceFingerprints);
  assertCondition(result.count === 4, 'CP_READER_STATE_MISMATCH');
  assertCondition(uniqueInstances.size === 2, 'CP_INSTANCE_NOT_DISTINCT');
  assertCondition(result.instanceFingerprints.at(-1) === instanceFingerprint, 'CP_READER_MARKER_MISSING');
  return Object.freeze({
    phase,
    count: 4,
    writerStateLoaded: true,
    distinctInstances: true,
    instanceCount: 2,
  });
}

async function run(phase = process.argv[2]) {
  const verified = assert005fCloudEnvironment(process.env, phase);
  const pool = createPostgresPool({ config: verified.config });
  try {
    await checkPostgresReadiness({ pool });
    await assertSchemaReady(pool);
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
      batch: '005f-dual-instance-checkpointer-cloud',
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
      batch: '005f-dual-instance-checkpointer-cloud',
      status: 'FAIL',
      errorCode: normalizeErrorCode(error, 'CONFIGURATION_ERROR'),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  DEDICATED_SERVICE_CONFIRMATION,
  assertReaderPrecondition,
  assert005fCloudEnvironment,
  createGraph,
  resolveInstanceFingerprint,
  resolveVerificationThread,
  run,
  runPhase,
};
