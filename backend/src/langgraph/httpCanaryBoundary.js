const crypto = require('crypto');
const { getPostgresPool } = require('../db/postgresPool');
const { withPostgresThreadAdvisoryLock } = require('./postgresThreadAdvisoryLock');

const TOKEN_HEADER = 'x-diet-canary-token';
const HOLD_HEADER = 'x-diet-canary-hold-ms';
const FAULT_HEADER = 'x-diet-canary-fault';
const FAULT_CONFIRMATION = 'CONFIRMED_005H_HTTP_CANARY_FAULT_INJECTION';
const SIDE_EFFECT_FAULT_CONFIRMATION = 'CONFIRMED_005M_SIDE_EFFECT_FAULT_INJECTION';
const MAX_HOLD_MS = 15000;

function createBoundaryError(code, statusCode, message = code) {
  return Object.assign(new Error(message), { code, statusCode });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function assertHttpCanaryRequest({ policy, token, env = process.env } = {}) {
  if (!policy?.httpCanary) return Object.freeze({ required: false, authorized: true });
  const configured = String(env.LANGGRAPH_HTTP_CANARY_TOKEN || '');
  if (configured.length < 32) {
    throw createBoundaryError('HTTP_CANARY_TOKEN_CONFIG_INVALID', 503);
  }
  if (!safeEqual(token, configured)) {
    throw createBoundaryError('HTTP_CANARY_UNAUTHORIZED', 403, '当前接口仅供受控灰度验证');
  }
  return Object.freeze({ required: true, authorized: true });
}

function resolveHttpCanaryInstanceFingerprint({ policy, env = process.env } = {}) {
  if (!policy?.httpCanary) return null;
  const hostname = String(env.HOSTNAME || '').trim();
  const secret = String(env.LANGGRAPH_THREAD_HMAC_SECRET || '');
  if (!hostname || secret.length < 32) {
    throw createBoundaryError('HTTP_CANARY_INSTANCE_CONFIG_INVALID', 503);
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`005h-http-instance\0${hostname}`, 'utf8')
    .digest('hex');
}

function resolveHttpCanaryFaultControls({
  policy,
  holdMs,
  fault,
  env = process.env,
} = {}) {
  if (!policy?.httpCanary) {
    return Object.freeze({
      holdMs: 0,
      failAfterIdentity: false,
      failAfterAdvicePersistence: false,
    });
  }
  const holdText = String(holdMs || '').trim();
  const faultText = String(fault || '').trim().toLowerCase();
  const requested = Boolean(holdText || faultText);
  if (requested) {
    const requiredConfirmation = faultText === 'after-advice-persistence'
      ? SIDE_EFFECT_FAULT_CONFIRMATION
      : FAULT_CONFIRMATION;
    const configuredConfirmation = faultText === 'after-advice-persistence'
      ? String(env.RUN_005M_SIDE_EFFECT_FAULT_INJECTION || '').trim()
      : String(env.RUN_005H_FAULT_INJECTION || '').trim();
    if (configuredConfirmation !== requiredConfirmation) {
      throw createBoundaryError('HTTP_CANARY_FAULT_INJECTION_NOT_CONFIRMED', 403);
    }
  }
  if (holdText && !/^\d+$/.test(holdText)) {
    throw createBoundaryError('HTTP_CANARY_HOLD_INVALID', 400);
  }
  const parsedHoldMs = holdText ? Number(holdText) : 0;
  if (!Number.isSafeInteger(parsedHoldMs) || parsedHoldMs < 0 || parsedHoldMs > MAX_HOLD_MS) {
    throw createBoundaryError('HTTP_CANARY_HOLD_INVALID', 400);
  }
  if (faultText && !['after-identity', 'after-advice-persistence'].includes(faultText)) {
    throw createBoundaryError('HTTP_CANARY_FAULT_INVALID', 400);
  }
  return Object.freeze({
    holdMs: parsedHoldMs,
    failAfterIdentity: faultText === 'after-identity',
    failAfterAdvicePersistence: faultText === 'after-advice-persistence',
  });
}

async function withGraphThreadPolicy({
  config,
  policy,
  pool,
  withLock = withPostgresThreadAdvisoryLock,
  holdMs = 0,
  onLockAcquired,
  work,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof work !== 'function') {
    throw createBoundaryError('HTTP_CANARY_WORK_INVALID', 500);
  }
  if (!policy?.requiresThreadLock) return work(Object.freeze({ waitMs: 0 }));
  const scope = config?.configurable?.thread_id;
  return withLock({
    pool: pool || getPostgresPool(),
    scope,
    work: async ({ waitMs }) => {
      if (typeof onLockAcquired === 'function') onLockAcquired({ waitMs });
      if (holdMs > 0) await sleep(holdMs);
      return work(Object.freeze({ waitMs }));
    },
  });
}

async function invokeGraphWithCheckpointerPolicy({
  graph,
  input,
  config,
  policy,
  pool,
  withLock = withPostgresThreadAdvisoryLock,
  holdMs = 0,
  onLockAcquired,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!graph || typeof graph.invoke !== 'function') {
    throw createBoundaryError('HTTP_CANARY_GRAPH_INVALID', 500);
  }
  return withGraphThreadPolicy({
    config, policy, pool, withLock, holdMs, onLockAcquired, sleep,
    work: () => graph.invoke(input, config),
  });
}

module.exports = {
  FAULT_CONFIRMATION,
  FAULT_HEADER,
  HOLD_HEADER,
  MAX_HOLD_MS,
  SIDE_EFFECT_FAULT_CONFIRMATION,
  TOKEN_HEADER,
  assertHttpCanaryRequest,
  invokeGraphWithCheckpointerPolicy,
  resolveHttpCanaryFaultControls,
  resolveHttpCanaryInstanceFingerprint,
  safeEqual,
  withGraphThreadPolicy,
};
