const ROLLBACK_POLICY_CONFIRMATION = 'CONFIRMED_005I_AUTOMATIC_ROLLBACK_SIGNALS';

const RATE_FIELDS = Object.freeze([
  ['connectionTimeoutCount', 'connectionTimeoutRatePct', 'connectionTimeoutRatePct', 'CONNECTION_TIMEOUT_RATE'],
  ['transactionFailureCount', 'transactionFailureRatePct', 'transactionFailureRatePct', 'TRANSACTION_FAILURE_RATE'],
  ['httpSideEffectFailureCount', 'httpSideEffectFailureRatePct', 'httpSideEffectFailureRatePct', 'HTTP_SIDE_EFFECT_FAILURE_RATE'],
  ['identityFailureCount', 'identityFailureRatePct', 'identityFailureRatePct', 'IDENTITY_FAILURE_RATE'],
]);

function createSignalError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseInteger(env, name, { min, max }) {
  const text = String(env[name] ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw createSignalError('POSTGRES_ROLLBACK_POLICY_INVALID', `${name}必须是十进制整数`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw createSignalError(
      'POSTGRES_ROLLBACK_POLICY_INVALID',
      `${name}必须在${min}—${max}之间`
    );
  }
  return value;
}

function parsePostgresRollbackPolicy(env = process.env) {
  if (String(env.RUN_005I_ROLLBACK_POLICY || '').trim() !== ROLLBACK_POLICY_CONFIRMATION) {
    throw createSignalError(
      'POSTGRES_ROLLBACK_POLICY_CONFIRMATION_REQUIRED',
      'PostgreSQL自动回滚信号需要独立确认'
    );
  }
  return Object.freeze({
    minSamples: parseInteger(env, 'TENCENT_PG_ROLLBACK_MIN_SAMPLES', { min: 10, max: 1000000 }),
    poolSaturationPct: parseInteger(
      env,
      'TENCENT_PG_ROLLBACK_POOL_SATURATION_PCT',
      { min: 50, max: 100 }
    ),
    waitingClients: parseInteger(
      env,
      'TENCENT_PG_ROLLBACK_WAITING_CLIENTS',
      { min: 1, max: 10000 }
    ),
    readinessFailures: parseInteger(
      env,
      'TENCENT_PG_ROLLBACK_READINESS_FAILURES',
      { min: 1, max: 1000 }
    ),
    connectionTimeoutRatePct: parseInteger(
      env,
      'TENCENT_PG_ROLLBACK_CONNECTION_TIMEOUT_RATE_PCT',
      { min: 1, max: 100 }
    ),
    transactionFailureRatePct: parseInteger(
      env,
      'TENCENT_PG_ROLLBACK_TRANSACTION_FAILURE_RATE_PCT',
      { min: 1, max: 100 }
    ),
    httpSideEffectFailureRatePct: parseInteger(
      env,
      'TENCENT_PG_ROLLBACK_HTTP_SIDE_EFFECT_FAILURE_RATE_PCT',
      { min: 1, max: 100 }
    ),
    identityFailureRatePct: parseInteger(
      env,
      'TENCENT_PG_ROLLBACK_IDENTITY_FAILURE_RATE_PCT',
      { min: 1, max: 100 }
    ),
  });
}

function parseCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createSignalError('POSTGRES_OPERATIONAL_SNAPSHOT_INVALID', `${name}必须是非负整数`);
  }
  return value;
}

function createPostgresOperationalSnapshot({ pool, poolMax, counters = {} } = {}) {
  if (!pool || typeof pool !== 'object') {
    throw createSignalError('POSTGRES_OPERATIONAL_SNAPSHOT_INVALID', '缺少连接池快照');
  }
  const resolvedPoolMax = parseCounter(poolMax, 'poolMax');
  if (resolvedPoolMax < 1) {
    throw createSignalError('POSTGRES_OPERATIONAL_SNAPSHOT_INVALID', 'poolMax必须大于0');
  }
  const totalCount = parseCounter(pool.totalCount, 'pool.totalCount');
  const idleCount = parseCounter(pool.idleCount, 'pool.idleCount');
  const waitingCount = parseCounter(pool.waitingCount, 'pool.waitingCount');
  if (idleCount > totalCount || totalCount > resolvedPoolMax) {
    throw createSignalError('POSTGRES_OPERATIONAL_SNAPSHOT_INVALID', '连接池计数不一致');
  }
  const sampleCount = parseCounter(counters.sampleCount ?? 0, 'sampleCount');
  const snapshot = {
    poolMax: resolvedPoolMax,
    poolTotal: totalCount,
    poolIdle: idleCount,
    poolWaiting: waitingCount,
    poolInUse: totalCount - idleCount,
    poolSaturationPct: Math.round(((totalCount - idleCount) / resolvedPoolMax) * 10000) / 100,
    sampleCount,
    readinessConsecutiveFailures: parseCounter(
      counters.readinessConsecutiveFailures ?? 0,
      'readinessConsecutiveFailures'
    ),
  };
  for (const [countField, outputField] of RATE_FIELDS) {
    const count = parseCounter(counters[countField] ?? 0, countField);
    snapshot[countField] = count;
    snapshot[outputField] = sampleCount === 0
      ? 0
      : Math.round((count / sampleCount) * 10000) / 100;
  }
  return Object.freeze(snapshot);
}

function evaluatePostgresRollbackSignals(snapshot, policy) {
  if (!snapshot || !policy) {
    throw createSignalError('POSTGRES_ROLLBACK_EVALUATION_INVALID', '缺少运行快照或回滚策略');
  }
  const reasons = [];
  if (snapshot.poolWaiting >= policy.waitingClients) reasons.push('POOL_WAITING_CLIENTS');
  if (snapshot.poolSaturationPct >= policy.poolSaturationPct) reasons.push('POOL_SATURATION');
  if (snapshot.readinessConsecutiveFailures >= policy.readinessFailures) {
    reasons.push('READINESS_FAILURES');
  }
  if (snapshot.sampleCount >= policy.minSamples) {
    for (const [, snapshotRateField, policyField, reason] of RATE_FIELDS) {
      if (snapshot[snapshotRateField] >= policy[policyField]) reasons.push(reason);
    }
  }
  if (reasons.length > 0) {
    return Object.freeze({ action: 'rollback', shouldRollback: true, reasons: Object.freeze(reasons) });
  }
  if (snapshot.sampleCount < policy.minSamples) {
    return Object.freeze({
      action: 'hold',
      shouldRollback: false,
      reasons: Object.freeze(['INSUFFICIENT_SAMPLES']),
    });
  }
  return Object.freeze({ action: 'continue', shouldRollback: false, reasons: Object.freeze([]) });
}

module.exports = {
  RATE_FIELDS,
  ROLLBACK_POLICY_CONFIRMATION,
  createPostgresOperationalSnapshot,
  evaluatePostgresRollbackSignals,
  parsePostgresRollbackPolicy,
};
