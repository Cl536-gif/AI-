const crypto = require('crypto');
const {
  EXPECTED_DATABASE,
  EXPECTED_USER,
  parsePostgresPoolConfig,
} = require('./postgresPoolConfig');

const CLOUD_VERIFY_CONFIRMATION = 'CONFIRMED_PRIVATE_VPC';
const SAFE_ERROR_CODE = /^[A-Za-z0-9_-]{1,32}$/;

function isPrivateIpv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function assertCloudVerificationEnvironment(env = process.env) {
  if (String(env.RUN_003D_CLOUD_VERIFY || '').trim() !== CLOUD_VERIFY_CONFIRMATION) {
    throw Object.assign(new Error('003d真实云端验证尚未获得明确授权'), {
      code: 'VERIFY_CONFIRMATION_REQUIRED',
    });
  }
  if (String(env.USER_STORE_ADAPTER || '').trim() !== 'sqlite') {
    throw Object.assign(new Error('003d期间不得切换UserStore适配器'), {
      code: 'USER_STORE_MUST_REMAIN_SQLITE',
    });
  }

  const config = parsePostgresPoolConfig(env);
  if (!isPrivateIpv4(config.host)) {
    throw Object.assign(new Error('003d只允许连接RFC1918私网IPv4地址'), {
      code: 'PRIVATE_IPV4_REQUIRED',
    });
  }
  if (config.port !== 5432) {
    throw Object.assign(new Error('003d只允许连接已审核的PostgreSQL端口'), {
      code: 'POSTGRES_PORT_MUST_BE_5432',
    });
  }
  return config;
}

function createVerificationConfig(config) {
  return Object.freeze({
    ...config,
    poolMax: 1,
    connectTimeoutMs: 750,
    statementTimeoutMs: Math.min(config.statementTimeoutMs, 5000),
    lockTimeoutMs: Math.min(config.lockTimeoutMs, 2000),
    idleTransactionTimeoutMs: Math.min(config.idleTransactionTimeoutMs, 10000),
  });
}

function createVerificationIds() {
  const suffix = crypto.randomBytes(8).toString('hex');
  return Object.freeze({
    userA: `acct:003d_a_${suffix}`,
    userB: `acct:003d_b_${suffix}`,
    eventId: `003d_event_${suffix}`,
    idempotencyKey: `003d_idem_${suffix}`,
    ddlTable: `dmc_003d_${suffix}`,
  });
}

function normalizeErrorCode(error, fallback = 'UNKNOWN') {
  const code = error && typeof error.code === 'string' ? error.code : '';
  const safeFallback = SAFE_ERROR_CODE.test(fallback) ? fallback : 'UNKNOWN';
  return SAFE_ERROR_CODE.test(code) ? code : safeFallback;
}

function createEvidenceRecorder({ write = console.log, now = () => new Date() } = {}) {
  const checks = [];
  function record(check, details = {}) {
    const entry = Object.freeze({
      batch: '003d',
      check,
      status: 'PASS',
      at: now().toISOString(),
      ...details,
    });
    checks.push(entry);
    write(JSON.stringify(entry));
    return entry;
  }
  return Object.freeze({ checks, record });
}

function assertExpectedIdentity(row) {
  if (!row || row.database_name !== EXPECTED_DATABASE || row.role_name !== EXPECTED_USER) {
    throw Object.assign(new Error('数据库或角色与003设计不一致'), {
      code: 'VERIFY_DATABASE_IDENTITY_MISMATCH',
    });
  }
}

module.exports = {
  CLOUD_VERIFY_CONFIRMATION,
  assertCloudVerificationEnvironment,
  assertExpectedIdentity,
  createEvidenceRecorder,
  createVerificationConfig,
  createVerificationIds,
  isPrivateIpv4,
  normalizeErrorCode,
};
