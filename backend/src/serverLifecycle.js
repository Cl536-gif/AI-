const { closePostgresPool } = require('./db/postgresPool');
const { logSafePostgresError } = require('./db/postgresDiagnostics');

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const FORCE_RESOURCE_CLOSE_TIMEOUT_MS = 1000;

function assertShutdownOptions(server, closeResources, timeoutMs) {
  if (!server || typeof server.close !== 'function') {
    throw new TypeError('优雅关闭需要HTTP服务器实例');
  }
  if (typeof closeResources !== 'function') {
    throw new TypeError('优雅关闭需要资源关闭函数');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new TypeError('关闭超时必须在100—60000毫秒之间');
  }
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    } catch (error) {
      reject(error);
    }
  });
}

function createGracefulShutdown({
  server,
  closeResources = closePostgresPool,
  logger = console,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  processRef = process,
  exit = (code) => processRef.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  assertShutdownOptions(server, closeResources, timeoutMs);

  let shutdownPromise = null;
  let timeoutHandle = null;

  function safeInfo(signal) {
    if (!logger || typeof logger.log !== 'function') return;
    const safeSignal = signal === 'SIGINT' || signal === 'SIGTERM' ? signal : 'shutdown';
    try {
      logger.log('[shutdown] started', { event: 'shutdown_started', signal: safeSignal });
    } catch (_) {
      // 日志失败不能阻止关闭。
    }
  }

  function forceCloseConnections() {
    if (typeof server.closeAllConnections === 'function') {
      try {
        server.closeAllConnections();
      } catch (_) {
        // 继续尝试关闭数据库资源。
      }
    }
  }

  async function bestEffortCloseResources() {
    let resourceTimeoutHandle = null;
    const resourceTimeout = new Promise((resolve) => {
      resourceTimeoutHandle = setTimer(resolve, FORCE_RESOURCE_CLOSE_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        Promise.resolve().then(closeResources).catch((error) => {
          logSafePostgresError(
            logger,
            '[shutdown] resource close failed',
            error,
            'shutdown_resource_close_failed'
          );
        }),
        resourceTimeout,
      ]);
    } finally {
      if (resourceTimeoutHandle !== null) clearTimer(resourceTimeoutHandle);
    }
  }

  async function runShutdown(signal) {
    safeInfo(signal);
    let timedOut = false;
    const gracefulWork = closeHttpServer(server).then(closeResources);
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimer(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    try {
      await Promise.race([gracefulWork, timeout]);
      if (timedOut) {
        forceCloseConnections();
        await bestEffortCloseResources();
        logSafePostgresError(
          logger,
          '[shutdown] timed out',
          { code: 'SHUTDOWN_TIMEOUT' },
          'shutdown_timed_out'
        );
        exit(1);
        return Object.freeze({ status: 'timed_out' });
      }
      exit(0);
      return Object.freeze({ status: 'closed' });
    } catch (error) {
      forceCloseConnections();
      await bestEffortCloseResources();
      logSafePostgresError(
        logger,
        '[shutdown] failed',
        error,
        'shutdown_failed'
      );
      exit(1);
      return Object.freeze({ status: 'failed' });
    } finally {
      if (timeoutHandle !== null) clearTimer(timeoutHandle);
    }
  }

  function shutdown(signal) {
    if (!shutdownPromise) shutdownPromise = runShutdown(signal);
    return shutdownPromise;
  }

  const signalHandlers = {
    SIGTERM: () => shutdown('SIGTERM'),
    SIGINT: () => shutdown('SIGINT'),
  };

  if (processRef && typeof processRef.once === 'function') {
    processRef.once('SIGTERM', signalHandlers.SIGTERM);
    processRef.once('SIGINT', signalHandlers.SIGINT);
  }

  function dispose() {
    if (!processRef || typeof processRef.removeListener !== 'function') return;
    processRef.removeListener('SIGTERM', signalHandlers.SIGTERM);
    processRef.removeListener('SIGINT', signalHandlers.SIGINT);
  }

  return Object.freeze({ shutdown, dispose });
}

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createGracefulShutdown,
};
