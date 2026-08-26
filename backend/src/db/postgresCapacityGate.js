const CAPACITY_REVIEW_CONFIRMATION = 'CONFIRMED_005I_FULL_CAPACITY_REVIEW';

function createCapacityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseInteger(env, name, { min, max }) {
  const text = String(env[name] ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw createCapacityError(
      'POSTGRES_FULL_CAPACITY_CONFIGURATION_INVALID',
      `${name}必须是十进制整数`
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw createCapacityError(
      'POSTGRES_FULL_CAPACITY_CONFIGURATION_INVALID',
      `${name}必须在${min}—${max}之间`
    );
  }
  return value;
}

function assertFullPostgresCapacityAllowed({ env = process.env } = {}) {
  if (String(env.RUN_005I_CAPACITY_REVIEW || '').trim() !== CAPACITY_REVIEW_CONFIRMATION) {
    throw createCapacityError(
      'POSTGRES_FULL_CAPACITY_CONFIRMATION_REQUIRED',
      'PostgreSQL全量容量预算需要独立评审确认'
    );
  }

  const maxInstances = parseInteger(env, 'TENCENT_PG_FULL_MAX_INSTANCES', { min: 2, max: 10 });
  const poolMax = parseInteger(env, 'TENCENT_PG_POOL_MAX', { min: 1, max: 20 });
  const observedMaxInstances = parseInteger(
    env,
    'TENCENT_PG_OBSERVED_MAX_INSTANCES',
    { min: 2, max: 10 }
  );
  const observedPoolMax = parseInteger(env, 'TENCENT_PG_OBSERVED_POOL_MAX', { min: 1, max: 20 });
  const databaseMaxConnections = parseInteger(
    env,
    'TENCENT_PG_DATABASE_MAX_CONNECTIONS',
    { min: 10, max: 10000 }
  );
  const operationalReserveConnections = parseInteger(
    env,
    'TENCENT_PG_OPERATIONAL_RESERVE_CONNECTIONS',
    { min: 2, max: 1000 }
  );
  const applicationConnectionBudget = parseInteger(
    env,
    'TENCENT_PG_FULL_CONNECTION_BUDGET',
    { min: 1, max: 10000 }
  );

  if (observedMaxInstances !== maxInstances || observedPoolMax !== poolMax) {
    throw createCapacityError(
      'POSTGRES_FULL_CAPACITY_TOPOLOGY_MISMATCH',
      '控制台复核的实例或连接池上限与发布声明不一致'
    );
  }

  const applicationConnectionLimit = maxInstances * poolMax;
  const databaseApplicationLimit = databaseMaxConnections - operationalReserveConnections;
  if (
    databaseApplicationLimit < 1
    || applicationConnectionBudget > databaseApplicationLimit
    || applicationConnectionLimit > applicationConnectionBudget
  ) {
    throw createCapacityError(
      'POSTGRES_FULL_CAPACITY_BUDGET_EXCEEDED',
      '实例与连接池总上限超过数据库安全连接预算'
    );
  }

  return Object.freeze({
    maxInstances,
    poolMax,
    observedMaxInstances,
    observedPoolMax,
    applicationConnectionLimit,
    applicationConnectionBudget,
    databaseMaxConnections,
    operationalReserveConnections,
    databaseApplicationLimit,
    applicationHeadroom: applicationConnectionBudget - applicationConnectionLimit,
    databaseHeadroom: databaseApplicationLimit - applicationConnectionLimit,
    verified: true,
  });
}

module.exports = {
  CAPACITY_REVIEW_CONFIRMATION,
  assertFullPostgresCapacityAllowed,
};
