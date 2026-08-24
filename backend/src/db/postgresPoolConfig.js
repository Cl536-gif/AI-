const EXPECTED_DATABASE = 'diet_secretary';
const EXPECTED_USER = 'diet_app';

const DEFAULTS = Object.freeze({
  port: 5432,
  sslMode: 'require',
  poolMax: 5,
  idleTimeoutMs: 30000,
  connectTimeoutMs: 5000,
  statementTimeoutMs: 10000,
  lockTimeoutMs: 3000,
  idleTransactionTimeoutMs: 15000,
});

const INTEGER_RULES = Object.freeze({
  TENCENT_PG_PORT: { min: 1, max: 65535, defaultValue: DEFAULTS.port },
  TENCENT_PG_POOL_MAX: { min: 1, max: 20, defaultValue: DEFAULTS.poolMax },
  TENCENT_PG_IDLE_TIMEOUT_MS: {
    min: 1000,
    max: 300000,
    defaultValue: DEFAULTS.idleTimeoutMs,
  },
  TENCENT_PG_CONNECT_TIMEOUT_MS: {
    min: 250,
    max: 30000,
    defaultValue: DEFAULTS.connectTimeoutMs,
  },
  TENCENT_PG_STATEMENT_TIMEOUT_MS: {
    min: 100,
    max: 120000,
    defaultValue: DEFAULTS.statementTimeoutMs,
  },
  TENCENT_PG_LOCK_TIMEOUT_MS: {
    min: 100,
    max: 30000,
    defaultValue: DEFAULTS.lockTimeoutMs,
  },
  TENCENT_PG_IDLE_TX_TIMEOUT_MS: {
    min: 1000,
    max: 120000,
    defaultValue: DEFAULTS.idleTransactionTimeoutMs,
  },
});

function readTrimmed(env, name) {
  return String(env[name] ?? '').trim();
}

function readRequired(env, name) {
  const value = readTrimmed(env, name);
  if (!value) throw new Error(`缺少必填环境变量 ${name}`);
  return value;
}

function parseBoundedInteger(env, name) {
  const rule = INTEGER_RULES[name];
  const raw = readTrimmed(env, name);
  if (!raw) return rule.defaultValue;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} 必须是十进制整数`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) {
    throw new Error(`${name} 必须在 ${rule.min}—${rule.max} 之间`);
  }
  return value;
}

function parseHost(env) {
  const host = readRequired(env, 'TENCENT_PG_HOST');
  if (
    host.length > 253
    || /[\s\0/\\]/.test(host)
    || host.includes('://')
  ) {
    throw new Error('TENCENT_PG_HOST 必须是单独的主机名或IP地址，不能包含协议、路径或空白');
  }
  return host;
}

function parsePassword(env) {
  const value = env.TENCENT_PG_PASSWORD;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('缺少必填环境变量 TENCENT_PG_PASSWORD');
  }
  if (value.length > 1024 || /[\0\r\n]/.test(value)) {
    throw new Error('TENCENT_PG_PASSWORD 格式不正确');
  }
  return value;
}

function decodeCertificateBase64(encoded) {
  if (!encoded || encoded.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('TENCENT_PG_SSL_CA_BASE64 必须是有效的Base64证书');
  }
  const normalizedInput = encoded.replace(/=+$/, '');
  const decoded = Buffer.from(encoded, 'base64');
  const normalizedRoundTrip = decoded.toString('base64').replace(/=+$/, '');
  const certificate = decoded.toString('utf8');
  if (
    normalizedRoundTrip !== normalizedInput
    || !certificate.includes('-----BEGIN CERTIFICATE-----')
    || !certificate.includes('-----END CERTIFICATE-----')
  ) {
    throw new Error('TENCENT_PG_SSL_CA_BASE64 必须解码为PEM证书');
  }
  return certificate;
}

function parseSsl(env) {
  const sslMode = readTrimmed(env, 'TENCENT_PG_SSL_MODE').toLowerCase() || DEFAULTS.sslMode;
  const caBase64 = readTrimmed(env, 'TENCENT_PG_SSL_CA_BASE64');
  if (!['disable', 'require', 'verify-full'].includes(sslMode)) {
    throw new Error('TENCENT_PG_SSL_MODE 只允许 disable、require、verify-full');
  }
  if (sslMode !== 'verify-full' && caBase64) {
    throw new Error('只有 verify-full 模式可以配置 TENCENT_PG_SSL_CA_BASE64');
  }
  if (sslMode === 'disable') return { sslMode, ssl: false };
  if (sslMode === 'require') {
    return { sslMode, ssl: Object.freeze({ rejectUnauthorized: false }) };
  }
  if (!caBase64) {
    throw new Error('verify-full 模式必须配置 TENCENT_PG_SSL_CA_BASE64');
  }
  return {
    sslMode,
    ssl: Object.freeze({
      rejectUnauthorized: true,
      ca: decodeCertificateBase64(caBase64),
    }),
  };
}

function parsePostgresPoolConfig(env = process.env) {
  const database = readRequired(env, 'TENCENT_PG_DATABASE');
  if (database !== EXPECTED_DATABASE) {
    throw new Error(`TENCENT_PG_DATABASE 必须固定为 ${EXPECTED_DATABASE}`);
  }

  const user = readRequired(env, 'TENCENT_PG_USER');
  if (user !== EXPECTED_USER) {
    throw new Error(`TENCENT_PG_USER 必须固定为最小权限账号 ${EXPECTED_USER}`);
  }

  const sslConfig = parseSsl(env);
  return Object.freeze({
    host: parseHost(env),
    port: parseBoundedInteger(env, 'TENCENT_PG_PORT'),
    database,
    user,
    password: parsePassword(env),
    sslMode: sslConfig.sslMode,
    ssl: sslConfig.ssl,
    poolMax: parseBoundedInteger(env, 'TENCENT_PG_POOL_MAX'),
    idleTimeoutMs: parseBoundedInteger(env, 'TENCENT_PG_IDLE_TIMEOUT_MS'),
    connectTimeoutMs: parseBoundedInteger(env, 'TENCENT_PG_CONNECT_TIMEOUT_MS'),
    statementTimeoutMs: parseBoundedInteger(env, 'TENCENT_PG_STATEMENT_TIMEOUT_MS'),
    lockTimeoutMs: parseBoundedInteger(env, 'TENCENT_PG_LOCK_TIMEOUT_MS'),
    idleTransactionTimeoutMs: parseBoundedInteger(env, 'TENCENT_PG_IDLE_TX_TIMEOUT_MS'),
  });
}

function redactPostgresPoolConfig(config) {
  return Object.freeze({
    ...config,
    password: '[REDACTED]',
    ssl: config.ssl && typeof config.ssl === 'object'
      ? Object.freeze({
        ...config.ssl,
        ...(config.ssl.ca ? { ca: '[REDACTED]' } : {}),
      })
      : config.ssl,
  });
}

module.exports = {
  DEFAULTS,
  EXPECTED_DATABASE,
  EXPECTED_USER,
  parsePostgresPoolConfig,
  redactPostgresPoolConfig,
};
