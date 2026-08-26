const {
  isTencentPostgresCutoverReady,
} = require('./tencentPostgresUserStoreCapabilities');
const {
  assertFullPostgresCapacityAllowed,
} = require('../db/postgresCapacityGate');
const {
  parsePostgresRollbackPolicy,
} = require('../db/postgresRollbackSignals');

const SINGLE_INSTANCE_CANARY_MODE = 'single_instance_canary';
const DUAL_INSTANCE_HTTP_CANARY_MODE = 'dual_instance_http_canary';
const FULL_CUTOVER_MODE = 'full';
const SINGLE_INSTANCE_CONFIRMATION = 'postgres-single-instance-canary';
const DUAL_INSTANCE_HTTP_CONFIRMATION = 'postgres-dual-instance-http-canary';
const FULL_CUTOVER_CONFIRMATION = 'postgres-full-cutover';

function createCutoverError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseRequiredPositiveInteger(value, name) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw createCutoverError('POSTGRES_CUTOVER_CONFIGURATION_INVALID', `${name}必须是正整数`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw createCutoverError('POSTGRES_CUTOVER_CONFIGURATION_INVALID', `${name}必须是正整数`);
  }
  return parsed;
}

function assertTencentPostgresCutoverAllowed({
  env = process.env,
  isFullCutoverReady = isTencentPostgresCutoverReady,
} = {}) {
  const mode = String(env.TENCENT_PG_CUTOVER_MODE || '').trim().toLowerCase();
  const confirmation = String(env.TENCENT_PG_CUTOVER_CONFIRM || '').trim();

  if (!mode) {
    throw createCutoverError(
      'POSTGRES_CUTOVER_MODE_REQUIRED',
      '选择Tencent PostgreSQL前必须显式配置灰度或全量切换模式'
    );
  }

  if (mode === SINGLE_INSTANCE_CANARY_MODE) {
    if (confirmation !== SINGLE_INSTANCE_CONFIRMATION) {
      throw createCutoverError(
        'POSTGRES_CANARY_CONFIRMATION_REQUIRED',
        '单实例PostgreSQL灰度需要显式确认'
      );
    }
    const maxInstances = parseRequiredPositiveInteger(
      env.TENCENT_PG_CANARY_MAX_INSTANCES,
      'TENCENT_PG_CANARY_MAX_INSTANCES'
    );
    const poolMax = parseRequiredPositiveInteger(env.TENCENT_PG_POOL_MAX, 'TENCENT_PG_POOL_MAX');
    if (maxInstances !== 1 || poolMax !== 1) {
      throw createCutoverError(
        'POSTGRES_CANARY_SCOPE_INVALID',
        '首次PostgreSQL灰度必须声明单实例且连接池上限为1'
      );
    }
    return Object.freeze({ mode, maxInstances, poolMax, allowed: true });
  }

  if (mode === DUAL_INSTANCE_HTTP_CANARY_MODE) {
    if (confirmation !== DUAL_INSTANCE_HTTP_CONFIRMATION) {
      throw createCutoverError(
        'POSTGRES_HTTP_CANARY_CONFIRMATION_REQUIRED',
        '双实例PostgreSQL HTTP灰度需要独立显式确认'
      );
    }
    if (String(env.RUN_005H_DEDICATED_SERVICE || '').trim()
        !== 'CONFIRMED_005H_DEDICATED_HTTP_CANARY_SERVICE') {
      throw createCutoverError(
        'POSTGRES_HTTP_CANARY_DEDICATED_SERVICE_REQUIRED',
        '双实例HTTP灰度只能在独立验证服务运行'
      );
    }
    const maxInstances = parseRequiredPositiveInteger(
      env.TENCENT_PG_HTTP_CANARY_MAX_INSTANCES,
      'TENCENT_PG_HTTP_CANARY_MAX_INSTANCES'
    );
    const poolMax = parseRequiredPositiveInteger(env.TENCENT_PG_POOL_MAX, 'TENCENT_PG_POOL_MAX');
    if (maxInstances !== 2 || poolMax !== 2) {
      throw createCutoverError(
        'POSTGRES_HTTP_CANARY_SCOPE_INVALID',
        '双实例HTTP灰度必须声明实例上限2且每实例连接池上限2'
      );
    }
    return Object.freeze({ mode, maxInstances, poolMax, allowed: true, productionReady: false });
  }

  if (mode === FULL_CUTOVER_MODE) {
    if (confirmation !== FULL_CUTOVER_CONFIRMATION) {
      throw createCutoverError(
        'POSTGRES_FULL_CUTOVER_CONFIRMATION_REQUIRED',
        'PostgreSQL全量切换需要独立显式确认'
      );
    }
    if (!isFullCutoverReady()) {
      throw createCutoverError(
        'POSTGRES_FULL_CUTOVER_NOT_READY',
        'Tencent PostgreSQL尚未满足全量切换门槛'
      );
    }
    const capacity = assertFullPostgresCapacityAllowed({ env });
    const rollbackPolicy = parsePostgresRollbackPolicy(env);
    return Object.freeze({ mode, capacity, rollbackPolicy, allowed: true });
  }

  throw createCutoverError(
    'POSTGRES_CUTOVER_MODE_UNSUPPORTED',
    `不支持的PostgreSQL切换模式：${mode}`
  );
}

module.exports = {
  SINGLE_INSTANCE_CANARY_MODE,
  DUAL_INSTANCE_HTTP_CANARY_MODE,
  FULL_CUTOVER_MODE,
  SINGLE_INSTANCE_CONFIRMATION,
  DUAL_INSTANCE_HTTP_CONFIRMATION,
  FULL_CUTOVER_CONFIRMATION,
  assertTencentPostgresCutoverAllowed,
};
