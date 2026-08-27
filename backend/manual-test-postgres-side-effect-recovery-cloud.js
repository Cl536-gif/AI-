const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres');
const { workflow } = require('./src/langgraph/graph');
const { getMessageRole, getMessageText } = require('./src/langgraph/utils/messages');
const { createPostgresPool, closePostgresPool } = require('./src/db/postgresPool');
const { checkPostgresReadiness } = require('./src/db/postgresReadiness');
const { normalizeErrorCode } = require('./src/db/postgresCloudVerification');
const {
  POSTGRES_CHECKPOINTER_SCHEMA,
  POSTGRES_CHECKPOINTER_VERSION,
  createPostgresLangGraphCheckpointer,
} = require('./src/langgraph/postgresCheckpointer');
const { resolveInternalThreadId } = require('./src/langgraph/threadScope');
const {
  SIDE_EFFECT_FAULT_CONFIRMATION,
} = require('./src/langgraph/httpCanaryBoundary');
const {
  DUAL_INSTANCE_HTTP_CANARY_MODE,
  assertTencentPostgresCutoverAllowed,
} = require('./src/stores/tencentPostgresCutoverGate');
const {
  POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  resolveLangGraphCheckpointerPolicy,
} = require('./src/langgraph/checkpointerProvider');
const { createTencentPostgresUserStore } = require('./src/stores/tencentPostgresUserStore');
const { resolveAnonymousUser } = require('./src/services/identityService');
const {
  FIXED_DEVICE_ID: UNUSED_005H_DEVICE_ID,
  postCanary,
  resolveInstanceFingerprint,
} = require('./manual-test-langgraph-postgres-http-canary-cloud');

const CONFIRMATION = 'CONFIRMED_005M_SIDE_EFFECT_RECOVERY_CLOUD';
const DEDICATED_CONFIRMATION = 'CONFIRMED_005M_DEDICATED_RECOVERY_SERVICE';
const PHASES = new Set(['fault', 'recover', 'verify', 'cleanup-checkpointer']);
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const FIXED_DEVICE_ID = '005d0000-0000-4000-8000-000000000001';
const MESSAGE = '今天午餐怎么吃？请给一个不依赖个人档案的通用搭配。';

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function assertCondition(condition, code) {
  if (!condition) fail(code);
}

function resolveLocalUrl(env = process.env) {
  const port = String(env.PORT || '').trim();
  assertCondition(/^\d+$/.test(port), 'LOCAL_HTTP_PORT_REQUIRED');
  const value = Number(port);
  assertCondition(value >= 1 && value <= 65535, 'LOCAL_HTTP_PORT_INVALID');
  return `http://127.0.0.1:${value}/api/chat-langgraph`;
}

function assert005mSideEffectRecoveryEnvironment(env = process.env, phase = process.argv[2]) {
  if (String(env.RUN_005M_SIDE_EFFECT_RECOVERY_VERIFY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.RUN_005M_DEDICATED_SERVICE || '').trim() !== DEDICATED_CONFIRMATION) {
    fail('DEDICATED_SERVICE_REQUIRED');
  }
  if (String(env.RUN_005M_SIDE_EFFECT_FAULT_INJECTION || '').trim()
      !== SIDE_EFFECT_FAULT_CONFIRMATION) {
    fail('FAULT_INJECTION_CONFIRMATION_REQUIRED');
  }
  if (!PHASES.has(phase)) fail('VERIFY_PHASE_INVALID');
  const runId = String(env.LANGGRAPH_SIDE_EFFECT_RECOVERY_RUN_ID || '').trim().toLowerCase();
  if (!RUN_ID_PATTERN.test(runId)) fail('VERIFY_RUN_ID_INVALID');
  assertCondition(String(env.LANGGRAPH_HTTP_CANARY_TOKEN || '').length >= 32, 'HTTP_TOKEN_REQUIRED');
  const cutover = assertTencentPostgresCutoverAllowed({ env });
  const policy = resolveLangGraphCheckpointerPolicy({ env });
  assertCondition(cutover.mode === DUAL_INSTANCE_HTTP_CANARY_MODE, 'HTTP_CUTOVER_MODE_REQUIRED');
  assertCondition(cutover.maxInstances === 2 && cutover.poolMax === 2, 'HTTP_TOPOLOGY_INVALID');
  assertCondition(policy.mode === POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE, 'HTTP_CHECKPOINTER_MODE_REQUIRED');
  assertCondition(policy.httpCanary && policy.requiresThreadLock, 'HTTP_LOCK_POLICY_REQUIRED');
  assertCondition(policy.productionReady === false, 'PRODUCTION_GATE_OPENED');
  return Object.freeze({
    phase,
    runId,
    localUrl: resolveLocalUrl(env),
    instanceFingerprint: resolveInstanceFingerprint(env),
  });
}

function resolveVerificationThread({ runId, userId, env = process.env }) {
  const publicThreadId = `005m-side-effect-${runId}`;
  return Object.freeze({
    publicThreadId,
    internalThreadId: resolveInternalThreadId({
      publicThreadId,
      userId,
      checkpointerPolicy: { backend: 'postgres' },
      env,
    }),
  });
}

function currentOperation(state) {
  const request = String(state?.persistenceRequest?.operationId || '');
  const receipt = String(state?.persistenceReceipt?.operationId || '');
  assertCondition(/^[0-9a-f-]{36}$/.test(request), 'PERSISTENCE_REQUEST_MISSING');
  return Object.freeze({ request, receipt });
}

function matchingHumanMessageCount(state) {
  return (state?.messages || []).filter((message) => (
    getMessageRole(message) === 'human' && getMessageText(message).trim() === MESSAGE
  )).length;
}

async function adviceForThread(store, userId, publicThreadId) {
  const advice = await store.listAdviceHistory(userId, { limit: 200 });
  return advice.filter((item) => item.threadId === publicThreadId);
}

async function countRawCheckpointerKeys(pool, keys) {
  const result = await pool.query({
    text: [
      'SELECT',
      `  (SELECT count(*)::int FROM ${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoints WHERE thread_id = ANY($1::text[])) AS checkpoints,`,
      `  (SELECT count(*)::int FROM ${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoint_blobs WHERE thread_id = ANY($1::text[])) AS blobs,`,
      `  (SELECT count(*)::int FROM ${POSTGRES_CHECKPOINTER_SCHEMA}.checkpoint_writes WHERE thread_id = ANY($1::text[])) AS writes`,
    ].join('\n'),
    values: [keys],
  });
  return result.rows[0];
}

async function runPhase({ verified, pool, checkpointer, graph, store, env = process.env }) {
  const token = String(env.LANGGRAPH_HTTP_CANARY_TOKEN || '');
  const userId = await resolveAnonymousUser(FIXED_DEVICE_ID, { store });
  const { publicThreadId, internalThreadId } = resolveVerificationThread({
    runId: verified.runId,
    userId,
    env,
  });
  const config = { configurable: { thread_id: internalThreadId } };

  if (verified.phase === 'cleanup-checkpointer') {
    await checkpointer.deleteThread(internalThreadId);
    const remaining = await countRawCheckpointerKeys(pool, [
      internalThreadId, publicThreadId, FIXED_DEVICE_ID, userId, verified.runId,
    ]);
    assertCondition(
      remaining.checkpoints === 0 && remaining.blobs === 0 && remaining.writes === 0,
      'CP_CLEANUP_NOT_PROVEN'
    );
    return Object.freeze({
      phase: verified.phase,
      cleanup: 'PASS',
      remainingCheckpointRows: 0,
      dmsUserCleanupRequired: true,
    });
  }

  if (verified.phase === 'fault') {
    const existing = await checkpointer.getTuple(config);
    assertCondition(existing === undefined, 'CP_FAULT_PREEXISTING_STATE');
    assertCondition((await adviceForThread(store, userId, publicThreadId)).length === 0,
      'USER_SIDE_EFFECT_PREEXISTING');
    const response = await postCanary({
      url: verified.localUrl,
      token,
      threadId: publicThreadId,
      message: MESSAGE,
      fault: 'after-advice-persistence',
    });
    assertCondition(response.status === 503, 'CONTROLLED_FAULT_NOT_TRIGGERED');
    assertCondition(response.body?.code === 'HTTP_CANARY_FAULT_AFTER_ADVICE_PERSISTENCE',
      'CONTROLLED_FAULT_SHAPE_INVALID');
    const state = (await graph.getState(config))?.values;
    const operation = currentOperation(state);
    assertCondition(operation.receipt !== operation.request, 'PENDING_RECEIPT_NOT_PRESERVED');
    const advice = await adviceForThread(store, userId, publicThreadId);
    assertCondition(advice.length > 0, 'PARTIAL_ADVICE_NOT_PERSISTED');
    return Object.freeze({
      phase: verified.phase,
      httpStatus: 503,
      advicePersistedBeforeFault: true,
      receiptPending: true,
      partialAdviceRows: advice.length,
      instanceFingerprint: verified.instanceFingerprint,
    });
  }

  if (verified.phase === 'recover') {
    const beforeState = (await graph.getState(config))?.values;
    const beforeOperation = currentOperation(beforeState);
    assertCondition(beforeOperation.receipt !== beforeOperation.request, 'PENDING_RECEIPT_REQUIRED');
    const adviceBefore = await adviceForThread(store, userId, publicThreadId);
    assertCondition(adviceBefore.length > 0, 'PARTIAL_ADVICE_REQUIRED');
    const response = await postCanary({
      url: verified.localUrl,
      token,
      threadId: publicThreadId,
      message: MESSAGE,
    });
    assertCondition(response.status === 200, 'RECOVERY_HTTP_FAILED');
    const afterState = (await graph.getState(config))?.values;
    const afterOperation = currentOperation(afterState);
    assertCondition(afterOperation.request === beforeOperation.request, 'RECOVERY_OPERATION_CHANGED');
    assertCondition(afterOperation.receipt === afterOperation.request, 'RECOVERY_RECEIPT_MISSING');
    const adviceAfter = await adviceForThread(store, userId, publicThreadId);
    assertCondition(adviceAfter.length === adviceBefore.length, 'ADVICE_REPLAY_NOT_IDEMPOTENT');
    assertCondition(matchingHumanMessageCount(afterState) === 1, 'IDENTICAL_RETRY_ADVANCED_GRAPH');
    return Object.freeze({
      phase: verified.phase,
      httpStatus: 200,
      pendingTurnRecovered: true,
      receiptAcknowledged: true,
      adviceAppliedOnce: true,
      identicalRetryDidNotAdvanceGraph: true,
      instanceFingerprint: verified.instanceFingerprint,
    });
  }

  const state = (await graph.getState(config))?.values;
  const operation = currentOperation(state);
  assertCondition(operation.receipt === operation.request, 'FINAL_RECEIPT_MISMATCH');
  const advice = await adviceForThread(store, userId, publicThreadId);
  assertCondition(advice.length > 0, 'FINAL_ADVICE_MISSING');
  assertCondition(new Set(advice.map((item) => item.idempotencyKey)).size === advice.length,
    'FINAL_ADVICE_DUPLICATED');
  assertCondition(matchingHumanMessageCount(state) === 1, 'FINAL_GRAPH_ADVANCED_TWICE');
  const raw = await countRawCheckpointerKeys(pool, [
    publicThreadId, FIXED_DEVICE_ID, userId, verified.runId, UNUSED_005H_DEVICE_ID,
  ]);
  assertCondition(raw.checkpoints === 0 && raw.blobs === 0 && raw.writes === 0,
    'RAW_IDENTIFIERS_STORED');
  return Object.freeze({
    phase: verified.phase,
    pendingTurnRecovered: true,
    receiptAcknowledged: true,
    adviceAppliedOnce: true,
    identicalRetryDidNotAdvanceGraph: true,
    rawIdentifiersStored: false,
    userRowsEmitted: false,
  });
}

async function run(phase = process.argv[2]) {
  const verified = assert005mSideEffectRecoveryEnvironment(process.env, phase);
  const pool = createPostgresPool();
  const store = createTencentPostgresUserStore();
  try {
    await checkPostgresReadiness({ pool });
    const checkpointer = createPostgresLangGraphCheckpointer({
      pool,
      PostgresSaverClass: PostgresSaver,
    });
    const graph = workflow.compile({ checkpointer });
    const result = await runPhase({ verified, pool, checkpointer, graph, store });
    console.log(JSON.stringify({
      batch: '005m-side-effect-recovery-cloud',
      status: 'PASS',
      packageVersion: POSTGRES_CHECKPOINTER_VERSION,
      ...result,
    }));
  } finally {
    await pool.end().catch(() => undefined);
    await closePostgresPool().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      batch: '005m-side-effect-recovery-cloud',
      status: 'FAIL',
      errorCode: normalizeErrorCode(error, 'CONFIGURATION_ERROR'),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  DEDICATED_CONFIRMATION,
  FIXED_DEVICE_ID,
  MESSAGE,
  PHASES,
  assert005mSideEffectRecoveryEnvironment,
  run,
  runPhase,
};
