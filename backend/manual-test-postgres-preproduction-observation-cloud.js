const { performance } = require('node:perf_hooks');
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres');
const { createPostgresPool, closePostgresPool } = require('./src/db/postgresPool');
const { checkPostgresReadiness } = require('./src/db/postgresReadiness');
const { normalizeErrorCode } = require('./src/db/postgresCloudVerification');
const {
  POSTGRES_CHECKPOINTER_SCHEMA,
  POSTGRES_CHECKPOINTER_VERSION,
  createPostgresLangGraphCheckpointer,
} = require('./src/langgraph/postgresCheckpointer');
const { TOKEN_HEADER } = require('./src/langgraph/httpCanaryBoundary');
const { resolveInternalThreadId } = require('./src/langgraph/threadScope');
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

const CONFIRMATION = 'CONFIRMED_005P_PREPRODUCTION_OBSERVATION';
const DEDICATED_CONFIRMATION = 'CONFIRMED_005P_DEDICATED_PREPRODUCTION_SERVICE';
const LIVE_WINDOW_CONFIRMATION = 'CONFIRMED_005P_LIVE_60_MINUTE_WINDOW';
const PHASES = new Set(['observe', 'cleanup-checkpointer']);
const RUN_ID_PATTERN = /^005p-cloud-[0-9]{8}-[0-9]{2}$/;
const FIXED_DEVICE_ID = '00590000-0000-4000-8000-000000000001';
const MIN_OBSERVATION_MINUTES = 60;
const MIN_REQUEST_COUNT = 100;
// 明确指定餐次，确保新用户既获得不依赖档案的通用建议，也确实进入
// 建议持久化链；仅说“通用一餐”可能被图路由视为继续首次资料采集。
const MESSAGE = '今天午餐怎么吃？请给一个不依赖个人档案的通用搭配。';

function fail(code, message = code, details) {
  throw Object.assign(new Error(message), { code, details });
}

function assertCondition(condition, code) {
  if (!condition) fail(code);
}

function parseInteger(env, name, { min, max }) {
  const text = String(env[name] ?? '').trim();
  if (!/^\d+$/.test(text)) fail('PREPRODUCTION_OBSERVATION_CONFIGURATION_INVALID');
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('PREPRODUCTION_OBSERVATION_CONFIGURATION_INVALID');
  }
  return value;
}

function resolvePublicBaseUrl(env = process.env) {
  let url;
  try {
    url = new URL(String(env.PREPRODUCTION_005P_BASE_URL || '').trim());
  } catch (_error) {
    fail('PREPRODUCTION_BASE_URL_INVALID');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || !url.hostname.endsWith('.run.tcloudbase.com')
  ) {
    fail('PREPRODUCTION_BASE_URL_INVALID');
  }
  return url.origin;
}

function publicThreadId(runId, index) {
  return `005p-observe-${runId}-${String(index).padStart(3, '0')}`;
}

function assert005pCloudEnvironment(env = process.env, phase = process.argv[2]) {
  if (String(env.RUN_005P_PREPRODUCTION_VERIFY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.RUN_005P_DEDICATED_SERVICE || '').trim() !== DEDICATED_CONFIRMATION) {
    fail('DEDICATED_SERVICE_REQUIRED');
  }
  if (String(env.RUN_005P_LIVE_WINDOW || '').trim() !== LIVE_WINDOW_CONFIRMATION) {
    fail('LIVE_WINDOW_CONFIRMATION_REQUIRED');
  }
  if (!PHASES.has(phase)) fail('VERIFY_PHASE_INVALID');
  const runId = String(env.PREPRODUCTION_005P_RUN_ID || '').trim().toLowerCase();
  if (!RUN_ID_PATTERN.test(runId)) fail('VERIFY_RUN_ID_INVALID');
  assertCondition(String(env.LANGGRAPH_HTTP_CANARY_TOKEN || '').length >= 32, 'HTTP_TOKEN_REQUIRED');
  assertCondition(Boolean(String(env.BAILIAN_API_KEY || '').trim()), 'BAILIAN_CREDENTIALS_REQUIRED');
  assertCondition(Boolean(String(env.BAILIAN_APP_ID || '').trim()), 'BAILIAN_CREDENTIALS_REQUIRED');
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
    baseUrl: resolvePublicBaseUrl(env),
    observationMinutes: parseInteger(env, 'PREPRODUCTION_005P_OBSERVATION_MINUTES', {
      min: MIN_OBSERVATION_MINUTES,
      max: 180,
    }),
    requestCount: parseInteger(env, 'PREPRODUCTION_005P_REQUEST_COUNT', {
      min: MIN_REQUEST_COUNT,
      max: 1000,
    }),
  });
}

function createMetrics(requestCount) {
  return {
    requestCount,
    successfulRequests: 0,
    readinessFailures: 0,
    connectionTimeouts: 0,
    transactionFailures: 0,
    identityFailures: 0,
    sideEffectFailures: 0,
    http5xx: 0,
    poolWaitingMax: 0,
    responseFormatFailures: 0,
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function isTimeout(error) {
  return ['AbortError', 'TimeoutError'].includes(error?.name)
    || ['ABORT_ERR', 'ETIMEDOUT'].includes(error?.code);
}

async function collectPreproductionObservation({
  verified,
  token,
  fetchImpl = fetch,
  monotonicNow = () => performance.now(),
  wallNow = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const metrics = createMetrics(verified.requestCount);
  const fingerprints = new Set();
  const durationMs = verified.observationMinutes * 60 * 1000;
  const intervalMs = Math.ceil(durationMs / (verified.requestCount - 1));
  const startedMono = monotonicNow();
  const startedAt = new Date(wallNow()).toISOString();

  for (let index = 0; index < verified.requestCount; index += 1) {
    const target = startedMono + (index * intervalMs);
    const delay = Math.max(0, target - monotonicNow());
    if (delay > 0) await sleep(delay);

    try {
      const ready = await fetchImpl(`${verified.baseUrl}/api/ready?005p=${index}`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(15000),
      });
      if (ready.status !== 200) metrics.readinessFailures += 1;
      await ready.text();
    } catch (error) {
      metrics.readinessFailures += 1;
      if (isTimeout(error)) metrics.connectionTimeouts += 1;
    }

    try {
      const response = await fetchImpl(
        `${verified.baseUrl}/api/chat-langgraph?005p=${index}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            connection: 'close',
            [TOKEN_HEADER]: token,
          },
          body: JSON.stringify({
            message: MESSAGE,
            threadId: publicThreadId(verified.runId, index),
            deviceId: FIXED_DEVICE_ID,
            introAlreadyShown: true,
          }),
          signal: AbortSignal.timeout(60000),
        }
      );
      const body = await readJson(response);
      if (response.status >= 500) metrics.http5xx += 1;
      if (response.status !== 200) {
        metrics.transactionFailures += 1;
        continue;
      }
      if (!body || typeof body !== 'object') {
        metrics.responseFormatFailures += 1;
        metrics.transactionFailures += 1;
        continue;
      }
      if (body.identityStatus !== 'anonymous_resolved') metrics.identityFailures += 1;
      if (body.advicePersistence !== 'recorded') metrics.sideEffectFailures += 1;
      if (!Number.isSafeInteger(body.canaryPoolWaiting) || body.canaryPoolWaiting < 0) {
        metrics.responseFormatFailures += 1;
        metrics.transactionFailures += 1;
        continue;
      }
      metrics.poolWaitingMax = Math.max(metrics.poolWaitingMax, body.canaryPoolWaiting);
      if (!/^[a-f0-9]{64}$/.test(String(body.canaryInstanceFingerprint || ''))) {
        metrics.responseFormatFailures += 1;
        metrics.transactionFailures += 1;
        continue;
      }
      fingerprints.add(body.canaryInstanceFingerprint);
      metrics.successfulRequests += 1;
    } catch (error) {
      if (isTimeout(error)) metrics.connectionTimeouts += 1;
      else metrics.transactionFailures += 1;
    }
  }

  const elapsedMs = monotonicNow() - startedMono;
  const observationMinutes = Math.floor(elapsedMs / 60000);
  const details = Object.freeze({
    ...metrics,
    observationMinutes,
    instanceCount: fingerprints.size,
  });
  const zeroFields = [
    'readinessFailures', 'connectionTimeouts', 'transactionFailures',
    'identityFailures', 'sideEffectFailures', 'http5xx', 'poolWaitingMax',
    'responseFormatFailures',
  ];
  if (
    elapsedMs < durationMs
    || metrics.successfulRequests !== verified.requestCount
    || fingerprints.size !== 2
    || zeroFields.some((name) => details[name] !== 0)
  ) {
    fail('PREPRODUCTION_OBSERVATION_FAILED', undefined, details);
  }
  return Object.freeze({
    phase: 'observe',
    startedAt,
    endedAt: new Date(wallNow()).toISOString(),
    ...details,
    distinctInstances: true,
    responseContentEmitted: false,
  });
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

async function cleanupCheckpointer({ verified, env = process.env }) {
  const pool = createPostgresPool();
  const store = createTencentPostgresUserStore();
  try {
    await checkPostgresReadiness({ pool });
    const checkpointer = createPostgresLangGraphCheckpointer({
      pool,
      PostgresSaverClass: PostgresSaver,
    });
    const userId = await resolveAnonymousUser(FIXED_DEVICE_ID, { store });
    const internalIds = [];
    for (let index = 0; index < verified.requestCount; index += 1) {
      const id = publicThreadId(verified.runId, index);
      const internalId = resolveInternalThreadId({
        publicThreadId: id,
        userId,
        checkpointerPolicy: { backend: 'postgres' },
        env,
      });
      internalIds.push(internalId);
      await checkpointer.deleteThread(internalId);
    }
    const rawKeys = [
      ...internalIds,
      ...Array.from({ length: verified.requestCount }, (_, index) => publicThreadId(verified.runId, index)),
      FIXED_DEVICE_ID,
      userId,
      verified.runId,
    ];
    const remaining = await countStoredKeys(pool, rawKeys);
    assertCondition(
      remaining.checkpoints === 0 && remaining.blobs === 0 && remaining.writes === 0,
      'CP_CLEANUP_NOT_PROVEN'
    );
    return Object.freeze({
      phase: 'cleanup-checkpointer',
      cleanup: 'PASS',
      cleanedThreadCount: internalIds.length,
      remainingCheckpointRows: 0,
      dmsUserCleanupRequired: true,
    });
  } finally {
    await pool.end().catch(() => undefined);
    await closePostgresPool().catch(() => undefined);
  }
}

async function run(phase = process.argv[2]) {
  const verified = assert005pCloudEnvironment(process.env, phase);
  const result = phase === 'observe'
    ? await collectPreproductionObservation({
      verified,
      token: String(process.env.LANGGRAPH_HTTP_CANARY_TOKEN || ''),
    })
    : await cleanupCheckpointer({ verified });
  console.log(JSON.stringify({
    batch: '005p-preproduction-observation',
    status: 'PASS',
    packageVersion: POSTGRES_CHECKPOINTER_VERSION,
    ...result,
  }));
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      batch: '005p-preproduction-observation',
      status: 'FAIL',
      errorCode: normalizeErrorCode(error, error?.code || 'CONFIGURATION_ERROR'),
      ...(error?.details || {}),
      responseContentEmitted: false,
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  DEDICATED_CONFIRMATION,
  FIXED_DEVICE_ID,
  LIVE_WINDOW_CONFIRMATION,
  MESSAGE,
  MIN_OBSERVATION_MINUTES,
  MIN_REQUEST_COUNT,
  PHASES,
  assert005pCloudEnvironment,
  collectPreproductionObservation,
  publicThreadId,
  run,
};
