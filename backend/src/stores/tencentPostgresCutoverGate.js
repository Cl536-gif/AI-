const {
  isTencentPostgresCutoverReady,
} = require('./tencentPostgresUserStoreCapabilities');

const SINGLE_INSTANCE_CANARY_MODE = 'single_instance_canary';
const FULL_CUTOVER_MODE = 'full';
const SINGLE_INSTANCE_CONFIRMATION = 'postgres-single-instance-canary';
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
    return Object.freeze({ mode, allowed: true });
  }

  throw createCutoverError(
    'POSTGRES_CUTOVER_MODE_UNSUPPORTED',
    `不支持的PostgreSQL切换模式：${mode}`
  );
}

module.exports = {
  SINGLE_INSTANCE_CANARY_MODE,
  FULL_CUTOVER_MODE,
  SINGLE_INSTANCE_CONFIRMATION,
  FULL_CUTOVER_CONFIRMATION,
  assertTencentPostgresCutoverAllowed,
};
