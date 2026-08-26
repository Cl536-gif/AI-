const crypto = require('crypto');
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres');
const { createPostgresPool, closePostgresPool } = require('./src/db/postgresPool');
const { checkPostgresReadiness } = require('./src/db/postgresReadiness');
const {
  normalizeErrorCode,
} = require('./src/db/postgresCloudVerification');
const {
  POSTGRES_CHECKPOINTER_SCHEMA,
  POSTGRES_CHECKPOINTER_VERSION,
  createPostgresLangGraphCheckpointer,
} = require('./src/langgraph/postgresCheckpointer');
const {
  resolveInternalThreadId,
} = require('./src/langgraph/threadScope');
const {
  FAULT_CONFIRMATION,
  FAULT_HEADER,
  HOLD_HEADER,
  TOKEN_HEADER,
} = require('./src/langgraph/httpCanaryBoundary');
const {
  DUAL_INSTANCE_HTTP_CANARY_MODE,
  DUAL_INSTANCE_HTTP_CONFIRMATION,
  assertTencentPostgresCutoverAllowed,
} = require('./src/stores/tencentPostgresCutoverGate');
const {
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  POSTGRES_THREAD_LOCK_CONFIRMATION,
  resolveLangGraphCheckpointerPolicy,
} = require('./src/langgraph/checkpointerProvider');
const { createTencentPostgresUserStore } = require('./src/stores/tencentPostgresUserStore');
const { resolveAnonymousUser } = require('./src/services/identityService');

const CONFIRMATION = 'CONFIRMED_005H_HTTP_CANARY_CLOUD';
const PHASES = new Set([
  'boundary',
  'writer',
  'reader',
  'contender-a',
  'contender-b',
  'replay-marker',
  'verify',
  'cleanup-checkpointer',
]);
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const FIXED_DEVICE_ID = '00580000-0000-4000-8000-000000000001';
const MIN_PEER_WAIT_MS = 500;

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function assertCondition(condition, code) {
  if (!condition) fail(code);
}

function resolveInstanceFingerprint(env = process.env) {
  const hostname = String(env.HOSTNAME || '').trim();
  const secret = String(env.LANGGRAPH_THREAD_HMAC_SECRET || '');
  assertCondition(hostname.length >= 3 && hostname.length <= 253, 'INSTANCE_HOSTNAME_REQUIRED');
  assertCondition(secret.length >= 32, 'THREAD_SCOPE_SECRET_REQUIRED');
  return crypto
    .createHmac('sha256', secret)
    .update(`005h-http-instance\0${hostname}`, 'utf8')
    .digest('hex');
}

function resolveLocalUrl(env = process.env) {
  const port = String(env.PORT || '').trim();
  assertCondition(/^\d+$/.test(port), 'LOCAL_HTTP_PORT_REQUIRED');
  const value = Number(port);
  assertCondition(Number.isInteger(value) && value >= 1 && value <= 65535, 'LOCAL_HTTP_PORT_INVALID');
  return `http://127.0.0.1:${value}/api/chat-langgraph`;
}

function assert005hCloudEnvironment(env = process.env, phase = process.argv[2]) {
  if (String(env.RUN_005H_HTTP_VERIFY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (!PHASES.has(phase)) fail('VERIFY_PHASE_INVALID');
  if (String(env.RUN_005H_FAULT_INJECTION || '').trim() !== FAULT_CONFIRMATION) {
    fail('FAULT_INJECTION_CONFIRMATION_REQUIRED');
  }
  const runId = String(env.LANGGRAPH_HTTP_CANARY_RUN_ID || '').trim().toLowerCase();
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
    instanceFingerprint: resolveInstanceFingerprint(env),
    localUrl: resolveLocalUrl(env),
    policy,
  });
}

function resolveVerificationThread({ runId, userId, env = process.env }) {
  const publicThreadId = `005h-http-${runId}`;
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

async function postCanary({
  url,
  token,
  threadId,
  message,
  holdMs,
  fault,
  fetchImpl = fetch,
}) {
  const headers = {
    'content-type': 'application/json',
    [TOKEN_HEADER]: token,
  };
  if (holdMs != null) headers[HOLD_HEADER] = String(holdMs);
  if (fault) headers[FAULT_HEADER] = fault;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message,
      threadId,
      deviceId: FIXED_DEVICE_ID,
      introAlreadyShown: true,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_error) {
    fail('HTTP_RESPONSE_NOT_JSON');
  }
  return { status: response.status, body };
}

async function recordInstanceMarker({ store, userId, publicThreadId, runId, phase, fingerprint }) {
  return store.recordAdvice(userId, {
    adviceType: 'ad_hoc_meal_advice',
    serviceMode: 'free',
    content: '005h受控HTTP云验证实例标记',
    metadata: { batch: '005h', phase, instanceFingerprint: fingerprint },
    threadId: publicThreadId,
    idempotencyKey: `005h-marker:${runId}:${phase}`,
  });
}

async function listCheckpoints(checkpointer, config) {
  const tuples = [];
  for await (const tuple of checkpointer.list(config)) tuples.push(tuple);
  return tuples;
}

function assertLinearCheckpointChain(tuples) {
  assertCondition(tuples.length > 0, 'CP_CHAIN_EMPTY');
  const ids = new Set(tuples.map((tuple) => tuple.config.configurable?.checkpoint_id));
  const childrenByParent = new Map();
  let roots = 0;
  for (const tuple of tuples) {
    const parentId = tuple.parentConfig?.configurable?.checkpoint_id;
    if (!parentId) {
      roots += 1;
      continue;
    }
    assertCondition(ids.has(parentId), 'CP_CHAIN_PARENT_MISSING');
    const children = childrenByParent.get(parentId) || new Set();
    children.add(tuple.config.configurable?.checkpoint_id);
    childrenByParent.set(parentId, children);
  }
  assertCondition(roots === 1, 'CP_CHAIN_ROOT_INVALID');
  assertCondition(
    [...childrenByParent.values()].every((children) => children.size === 1),
    'CP_BRANCH_DETECTED'
  );
  return Object.freeze({ checkpointCount: tuples.length, branchCount: 0 });
}

async function countStoredKeys(pool, keys) {
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

function assertSuccessfulHttp(result, expectedFingerprint) {
  assertCondition(result.status === 200, 'HTTP_REQUEST_FAILED');
  assertCondition(result.body?.identityStatus === 'anonymous_resolved', 'HTTP_IDENTITY_NOT_RESOLVED');
  assertCondition(result.body?.threadId, 'HTTP_THREAD_MISSING');
  assertCondition(result.body?.canaryInstanceFingerprint === expectedFingerprint, 'HTTP_INSTANCE_MISMATCH');
  assertCondition(Number.isInteger(result.body?.canaryLockWaitMs), 'HTTP_LOCK_WAIT_MISSING');
}

async function runPhase({ verified, pool, checkpointer, store, env = process.env, fetchImpl = fetch }) {
  const token = String(env.LANGGRAPH_HTTP_CANARY_TOKEN || '');
  if (verified.phase === 'boundary') {
    const request = { url: verified.localUrl, threadId: `005h-http-${verified.runId}`, message: '边界检查' };
    const missing = await postCanary({ ...request, token: '', fetchImpl });
    const wrong = await postCanary({ ...request, token: `${token}x`, fetchImpl });
    assertCondition(missing.status === 403 && wrong.status === 403, 'HTTP_TOKEN_REJECTION_FAILED');
    const faulted = await postCanary({
      ...request,
      token,
      fault: 'after-identity',
      fetchImpl,
    });
    assertCondition(faulted.status === 503, 'HTTP_CONTROLLED_FAULT_NOT_TRIGGERED');
    assertCondition(faulted.body?.code === 'HTTP_CANARY_FAULT_AFTER_IDENTITY', 'HTTP_FAULT_SHAPE_INVALID');
    return Object.freeze({
      phase: 'boundary',
      missingTokenRejected: true,
      wrongTokenRejected: true,
      afterIdentityFaultInjected: true,
    });
  }

  const userId = await resolveAnonymousUser(FIXED_DEVICE_ID, { store });
  const { publicThreadId, internalThreadId } = resolveVerificationThread({
    runId: verified.runId,
    userId,
    env,
  });
  const config = { configurable: { thread_id: internalThreadId } };

  if (verified.phase === 'cleanup-checkpointer') {
    await checkpointer.deleteThread(internalThreadId);
    const remaining = await countStoredKeys(pool, [
      internalThreadId,
      publicThreadId,
      FIXED_DEVICE_ID,
      verified.runId,
    ]);
    assertCondition(
      remaining.checkpoints === 0 && remaining.blobs === 0 && remaining.writes === 0,
      'CP_CLEANUP_NOT_PROVEN'
    );
    return Object.freeze({
      phase: verified.phase,
      checkpointCleanup: 'PASS',
      remainingCheckpointRows: 0,
      dmsUserCleanupRequired: true,
    });
  }

  if (verified.phase === 'replay-marker') {
    await recordInstanceMarker({
      store, userId, publicThreadId, runId: verified.runId,
      phase: 'writer', fingerprint: verified.instanceFingerprint,
    });
    await recordInstanceMarker({
      store, userId, publicThreadId, runId: verified.runId,
      phase: 'writer', fingerprint: verified.instanceFingerprint,
    });
    const advice = await store.listAdviceHistory(userId, { limit: 200 });
    const matches = advice.filter((item) => item.idempotencyKey === `005h-marker:${verified.runId}:writer`);
    assertCondition(matches.length === 1, 'USER_STORE_REPLAY_NOT_IDEMPOTENT');
    return Object.freeze({ phase: verified.phase, markerAppliedOnce: true, matchingRows: 1 });
  }

  if (verified.phase === 'verify') {
    const latest = await checkpointer.getTuple(config);
    assertCondition(Boolean(latest), 'CP_FINAL_STATE_MISSING');
    const chain = assertLinearCheckpointChain(await listCheckpoints(checkpointer, config));
    const advice = await store.listAdviceHistory(userId, { limit: 200 });
    const markers = advice.filter((item) => String(item.idempotencyKey || '').startsWith(`005h-marker:${verified.runId}:`));
    const fingerprints = new Set(markers.map((item) => item.metadata?.instanceFingerprint).filter(Boolean));
    assertCondition(fingerprints.size === 2, 'HTTP_INSTANCE_SET_MISMATCH');
    const raw = await countStoredKeys(pool, [publicThreadId, FIXED_DEVICE_ID, userId, verified.runId]);
    assertCondition(raw.checkpoints === 0 && raw.blobs === 0 && raw.writes === 0, 'RAW_IDENTIFIERS_STORED');
    assertCondition(advice.some((item) => !String(item.idempotencyKey || '').startsWith('005h-marker:')), 'HTTP_ADVICE_NOT_PERSISTED');
    return Object.freeze({
      phase: verified.phase,
      distinctInstances: true,
      instanceCount: fingerprints.size,
      advicePersisted: true,
      ...chain,
      rawIdentifiersStored: false,
    });
  }

  const existing = await checkpointer.getTuple(config);
  if (verified.phase === 'writer') {
    assertCondition(existing === undefined, 'CP_WRITER_PREEXISTING_STATE');
  } else {
    assertCondition(Boolean(existing), 'CP_PREVIOUS_STATE_MISSING');
  }
  const messages = {
    writer: '今天午餐怎么吃？请给一个不依赖个人档案的通用搭配。',
    reader: '请把刚才的建议换成另一个通用版本。',
    'contender-a': '请给一个不依赖个人档案的早餐通用搭配。',
    'contender-b': '请给一个不依赖个人档案的晚餐通用搭配。',
  };
  const httpResult = await postCanary({
    url: verified.localUrl,
    token,
    threadId: publicThreadId,
    message: messages[verified.phase],
    holdMs: verified.phase === 'contender-a' ? 10000 : undefined,
    fetchImpl,
  });
  assertSuccessfulHttp(httpResult, verified.instanceFingerprint);
  assertCondition(httpResult.body.threadId === publicThreadId, 'HTTP_THREAD_CHANGED');
  if (verified.phase === 'contender-b') {
    assertCondition(httpResult.body.canaryLockWaitMs >= MIN_PEER_WAIT_MS, 'HTTP_PEER_OVERLAP_NOT_PROVEN');
  }
  await recordInstanceMarker({
    store,
    userId,
    publicThreadId,
    runId: verified.runId,
    phase: verified.phase,
    fingerprint: verified.instanceFingerprint,
  });
  return Object.freeze({
    phase: verified.phase,
    httpStatus: 200,
    previousCheckpointLoaded: verified.phase !== 'writer',
    identityResolved: true,
    advicePersistence: httpResult.body.advicePersistence,
    lockWaitMs: httpResult.body.canaryLockWaitMs,
    peerOverlapProven: verified.phase === 'contender-b' ? true : undefined,
    instanceFingerprint: verified.instanceFingerprint,
  });
}

async function run(phase = process.argv[2]) {
  const verified = assert005hCloudEnvironment(process.env, phase);
  const pool = createPostgresPool();
  const store = createTencentPostgresUserStore();
  try {
    await checkPostgresReadiness({ pool });
    const checkpointer = createPostgresLangGraphCheckpointer({
      pool,
      PostgresSaverClass: PostgresSaver,
    });
    const result = await runPhase({ verified, pool, checkpointer, store });
    console.log(JSON.stringify({
      batch: '005h-http-canary-cloud',
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
      batch: '005h-http-canary-cloud',
      status: 'FAIL',
      errorCode: normalizeErrorCode(error, 'CONFIGURATION_ERROR'),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  DUAL_INSTANCE_HTTP_CANARY_MODE,
  DUAL_INSTANCE_HTTP_CONFIRMATION,
  FIXED_DEVICE_ID,
  MIN_PEER_WAIT_MS,
  PHASES,
  POSTGRES_CHECKPOINTER_CONFIRMATION,
  POSTGRES_CHECKPOINTER_HTTP_CANARY_MODE,
  POSTGRES_THREAD_LOCK_CONFIRMATION,
  assert005hCloudEnvironment,
  assertLinearCheckpointChain,
  postCanary,
  resolveInstanceFingerprint,
  resolveVerificationThread,
  run,
  runPhase,
};
