const SAFE_ERROR_CODE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_CAUSE_DEPTH = 3;

const MESSAGE_CLASSIFIERS = Object.freeze([
  [/server does not support ssl connections/i, 'SSL_UNSUPPORTED'],
  [/(self[- ]signed certificate|unable to verify|certificate (?:has )?expired|hostname.*certificate)/i, 'TLS_CERTIFICATE_ERROR'],
  [/(TENCENT_PG_|缺少必填环境变量|必须固定为最小权限账号)/i, 'CONFIGURATION_ERROR'],
  [/(password authentication failed|SASL|client password must be a string)/i, 'AUTHENTICATION_FAILED'],
  [/no pg_hba\.conf entry/i, 'ACCESS_RULE_REJECTED'],
  [/database .* does not exist/i, 'DATABASE_NOT_FOUND'],
  [/role .* does not exist/i, 'ROLE_NOT_FOUND'],
  [/(getaddrinfo|ENOTFOUND|EAI_AGAIN)/i, 'HOST_RESOLUTION_FAILED'],
  [/(ECONNREFUSED|connection refused)/i, 'CONNECTION_REFUSED'],
  [/(ETIMEDOUT|connection timeout|timeout expired|timed out)/i, 'CONNECTION_TIMEOUT'],
  [/(connection terminated|connection ended unexpectedly)/i, 'CONNECTION_TERMINATED'],
  [/连接池正在关闭或已经关闭/i, 'POOL_CLOSED'],
]);

function readErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || (typeof current !== 'object' && typeof current !== 'function')) break;
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function classifyPostgresError(error) {
  const chain = readErrorChain(error);
  for (const current of chain) {
    const rawCode = typeof current.code === 'string' ? current.code : '';
    if (SAFE_ERROR_CODE.test(rawCode)) return rawCode;
  }

  const messages = chain
    .map((current) => (typeof current.message === 'string' ? current.message : ''))
    .filter(Boolean)
    .join('\n');
  for (const [pattern, category] of MESSAGE_CLASSIFIERS) {
    if (pattern.test(messages)) return category;
  }
  return 'UNKNOWN';
}

function safePostgresErrorDetails(error, event) {
  return Object.freeze({
    event,
    code: classifyPostgresError(error),
  });
}

function logSafePostgresError(logger, message, error, event) {
  if (!logger || typeof logger.error !== 'function') return;
  try {
    logger.error(message, safePostgresErrorDetails(error, event));
  } catch (_) {
    // 诊断日志本身不能让连接池或关闭流程崩溃。
  }
}

module.exports = {
  classifyPostgresError,
  logSafePostgresError,
  safePostgresErrorDetails,
};
