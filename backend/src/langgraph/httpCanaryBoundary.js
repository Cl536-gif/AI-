const crypto = require('crypto');
const { getPostgresPool } = require('../db/postgresPool');
const { withPostgresThreadAdvisoryLock } = require('./postgresThreadAdvisoryLock');

const TOKEN_HEADER = 'x-diet-canary-token';

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

async function invokeGraphWithCheckpointerPolicy({
  graph,
  input,
  config,
  policy,
  pool,
  withLock = withPostgresThreadAdvisoryLock,
} = {}) {
  if (!graph || typeof graph.invoke !== 'function') {
    throw createBoundaryError('HTTP_CANARY_GRAPH_INVALID', 500);
  }
  if (!policy?.requiresThreadLock) return graph.invoke(input, config);
  const scope = config?.configurable?.thread_id;
  return withLock({
    pool: pool || getPostgresPool(),
    scope,
    work: () => graph.invoke(input, config),
  });
}

module.exports = {
  TOKEN_HEADER,
  assertHttpCanaryRequest,
  invokeGraphWithCheckpointerPolicy,
  safeEqual,
};
