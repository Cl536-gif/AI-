const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_POLL_MS = 100;

function createLockError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function assertScope(scope) {
  if (typeof scope !== 'string' || !scope.trim() || scope.length > 1024) {
    throw createLockError('THREAD_LOCK_SCOPE_INVALID');
  }
}

function assertDuration(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw createLockError('THREAD_LOCK_CONFIG_INVALID', `${name}配置无效`);
  }
}

function deriveAdvisoryLockKeys(scope) {
  assertScope(scope);
  const digest = crypto.createHash('sha256').update(`langgraph-thread-lock\0${scope}`).digest();
  return Object.freeze([digest.readInt32BE(0), digest.readInt32BE(4)]);
}

async function withPostgresThreadAdvisoryLock({
  pool,
  scope,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  work,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw createLockError('THREAD_LOCK_POOL_INVALID');
  }
  if (typeof work !== 'function') {
    throw createLockError('THREAD_LOCK_WORK_INVALID');
  }
  assertDuration(timeoutMs, 'timeoutMs', 500, 60000);
  assertDuration(pollMs, 'pollMs', 25, 1000);
  const [key1, key2] = deriveAdvisoryLockKeys(scope);
  const client = await pool.connect();
  const startedAt = now();
  let acquired = false;
  let releaseError = null;
  try {
    while (!acquired) {
      const result = await client.query({
        text: 'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        values: [key1, key2],
      });
      acquired = result.rows[0]?.acquired === true;
      if (acquired) break;
      if (now() - startedAt >= timeoutMs) {
        throw createLockError('THREAD_LOCK_TIMEOUT');
      }
      await sleep(pollMs);
    }
    return await work(Object.freeze({ waitMs: now() - startedAt }));
  } finally {
    if (acquired) {
      try {
        const result = await client.query({
          text: 'SELECT pg_advisory_unlock($1, $2) AS released',
          values: [key1, key2],
        });
        if (result.rows[0]?.released !== true) {
          releaseError = createLockError('THREAD_LOCK_RELEASE_FAILED');
        }
      } catch (error) {
        releaseError = error instanceof Error
          ? error
          : createLockError('THREAD_LOCK_RELEASE_FAILED');
      }
    }
    client.release(releaseError || undefined);
    if (releaseError) throw releaseError;
  }
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  deriveAdvisoryLockKeys,
  withPostgresThreadAdvisoryLock,
};
