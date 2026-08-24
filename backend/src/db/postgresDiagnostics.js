const SAFE_ERROR_CODE = /^[A-Za-z0-9_-]{1,32}$/;

function safePostgresErrorDetails(error, event) {
  const rawCode = error && typeof error.code === 'string' ? error.code : '';
  return Object.freeze({
    event,
    code: SAFE_ERROR_CODE.test(rawCode) ? rawCode : 'UNKNOWN',
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
  logSafePostgresError,
  safePostgresErrorDetails,
};
