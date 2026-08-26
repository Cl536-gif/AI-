const FINAL_REVIEW_CONFIRMATION = 'CONFIRMED_005M_FINAL_GO_NO_GO_REVIEW';
const METHOD_EVIDENCE_CONFIRMATION = 'CONFIRMED_005M_37_METHODS_VERIFIED';
const ACCEPTANCE_INTEGRITY_CONFIRMATION = 'CONFIRMED_005M_ACCEPTANCE_MANIFESTS_VERIFIED';
const PREPRODUCTION_CONFIRMATION = 'CONFIRMED_005M_PREPRODUCTION_OBSERVATION';
const SIDE_EFFECT_RECOVERY_CONFIRMATION = 'CONFIRMED_005M_SIDE_EFFECT_RECOVERY';
const ROLLBACK_CONTROL_CONFIRMATION = 'CONFIRMED_005M_ROLLBACK_CONTROL';
const MODEL_MONITORING_CONFIRMATION = 'CONFIRMED_005M_MODEL_DEPENDENCY_MONITORING';

function createFinalGoNoGoError(code, message) {
  return Object.assign(new Error(message), { code });
}

function read(env, name) {
  return String(env[name] ?? '').trim();
}

function requireExact(env, name, expected, code) {
  if (read(env, name) !== expected) {
    throw createFinalGoNoGoError(code, `${name}缺少005m固定确认`);
  }
}

function parseInteger(env, name, { min, max }) {
  const raw = read(env, name);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw createFinalGoNoGoError('POSTGRES_FINAL_OBSERVATION_INVALID', `${name}必须是整数`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw createFinalGoNoGoError(
      'POSTGRES_FINAL_OBSERVATION_INVALID',
      `${name}必须在${min}—${max}之间`
    );
  }
  return value;
}

function assertFinalPostgresGoNoGoAllowed({ env = process.env } = {}) {
  requireExact(
    env,
    'RUN_005M_FINAL_REVIEW',
    FINAL_REVIEW_CONFIRMATION,
    'POSTGRES_FINAL_REVIEW_REQUIRED'
  );
  requireExact(
    env,
    'RUN_005M_METHOD_EVIDENCE',
    METHOD_EVIDENCE_CONFIRMATION,
    'POSTGRES_FINAL_METHOD_EVIDENCE_REQUIRED'
  );
  requireExact(
    env,
    'RUN_005M_ACCEPTANCE_INTEGRITY',
    ACCEPTANCE_INTEGRITY_CONFIRMATION,
    'POSTGRES_FINAL_ACCEPTANCE_INTEGRITY_REQUIRED'
  );
  requireExact(
    env,
    'RUN_005M_SIDE_EFFECT_RECOVERY',
    SIDE_EFFECT_RECOVERY_CONFIRMATION,
    'POSTGRES_FINAL_SIDE_EFFECT_RECOVERY_REQUIRED'
  );
  requireExact(
    env,
    'RUN_005M_ROLLBACK_CONTROL',
    ROLLBACK_CONTROL_CONFIRMATION,
    'POSTGRES_FINAL_ROLLBACK_CONTROL_REQUIRED'
  );
  requireExact(
    env,
    'RUN_005M_MODEL_MONITORING',
    MODEL_MONITORING_CONFIRMATION,
    'POSTGRES_FINAL_MODEL_MONITORING_REQUIRED'
  );
  requireExact(
    env,
    'RUN_005M_PREPRODUCTION_OBSERVATION',
    PREPRODUCTION_CONFIRMATION,
    'POSTGRES_FINAL_PREPRODUCTION_OBSERVATION_REQUIRED'
  );

  const observationMinutes = parseInteger(env, 'TENCENT_PG_005M_OBSERVATION_MINUTES', {
    min: 60,
    max: 10080,
  });
  const requestCount = parseInteger(env, 'TENCENT_PG_005M_REQUEST_COUNT', {
    min: 100,
    max: 1000000,
  });
  const zeroRequired = [
    'TENCENT_PG_005M_READINESS_FAILURES',
    'TENCENT_PG_005M_CONNECTION_TIMEOUTS',
    'TENCENT_PG_005M_TRANSACTION_FAILURES',
    'TENCENT_PG_005M_IDENTITY_FAILURES',
    'TENCENT_PG_005M_SIDE_EFFECT_FAILURES',
    'TENCENT_PG_005M_HTTP_5XX',
    'TENCENT_PG_005M_POOL_WAITING_MAX',
  ];
  const failures = Object.fromEntries(zeroRequired.map((name) => [
    name,
    parseInteger(env, name, { min: 0, max: 1000000 }),
  ]));
  if (Object.values(failures).some((value) => value !== 0)) {
    throw createFinalGoNoGoError(
      'POSTGRES_FINAL_OBSERVATION_FAILED',
      '005m预生产观察窗口存在失败或等待信号'
    );
  }

  return Object.freeze({
    decision: 'GO',
    observationMinutes,
    requestCount,
    failures: Object.freeze(failures),
    methodEvidenceVerified: true,
    acceptanceIntegrityVerified: true,
    sideEffectRecoveryVerified: true,
    rollbackControlVerified: true,
    modelMonitoringVerified: true,
    preproductionObservationVerified: true,
  });
}

module.exports = {
  ACCEPTANCE_INTEGRITY_CONFIRMATION,
  FINAL_REVIEW_CONFIRMATION,
  METHOD_EVIDENCE_CONFIRMATION,
  MODEL_MONITORING_CONFIRMATION,
  PREPRODUCTION_CONFIRMATION,
  ROLLBACK_CONTROL_CONFIRMATION,
  SIDE_EFFECT_RECOVERY_CONFIRMATION,
  assertFinalPostgresGoNoGoAllowed,
};
