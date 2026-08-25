const crypto = require('crypto');

const THREAD_SCOPE_VERSION = 'v1';
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 1024;

function createThreadScopeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseThreadScopeSecret(env = process.env) {
  const value = env.LANGGRAPH_THREAD_HMAC_SECRET;
  if (
    typeof value !== 'string'
    || value.length < MIN_SECRET_LENGTH
    || value.length > MAX_SECRET_LENGTH
    || /[\0\r\n]/.test(value)
  ) {
    throw createThreadScopeError(
      'LANGGRAPH_THREAD_SCOPE_SECRET_INVALID',
      '共享LangGraph checkpointer需要独立且长度至少32的thread作用域密钥'
    );
  }
  return value;
}

function assertThreadScopeConfig(env = process.env) {
  parseThreadScopeSecret(env);
  return Object.freeze({ configured: true, version: THREAD_SCOPE_VERSION });
}

function assertScopeInput(publicThreadId, userId) {
  if (typeof publicThreadId !== 'string' || !publicThreadId.trim()) {
    throw createThreadScopeError(
      'LANGGRAPH_PUBLIC_THREAD_ID_INVALID',
      '共享LangGraph checkpointer需要有效threadId'
    );
  }
  if (typeof userId !== 'string' || !userId.trim()) {
    throw createThreadScopeError(
      'LANGGRAPH_THREAD_IDENTITY_REQUIRED',
      '共享LangGraph checkpointer需要先解析服务端身份'
    );
  }
}

function resolveInternalThreadId({
  publicThreadId,
  userId,
  checkpointerPolicy,
  env = process.env,
} = {}) {
  if (!checkpointerPolicy || checkpointerPolicy.backend !== 'postgres') {
    return publicThreadId;
  }

  assertScopeInput(publicThreadId, userId);
  const secret = parseThreadScopeSecret(env);
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${THREAD_SCOPE_VERSION}\0${userId.trim()}\0${publicThreadId.trim()}`, 'utf8')
    .digest('hex');
  return `${THREAD_SCOPE_VERSION}:${digest}`;
}

module.exports = {
  THREAD_SCOPE_VERSION,
  MIN_SECRET_LENGTH,
  assertThreadScopeConfig,
  resolveInternalThreadId,
};
