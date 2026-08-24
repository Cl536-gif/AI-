const assert = require('assert');
const {
  CLOUD_VERIFY_CONFIRMATION,
  assertCloudVerificationEnvironment,
  assertExpectedIdentity,
  createEvidenceRecorder,
  createVerificationConfig,
  createVerificationIds,
  isPrivateIpv4,
  normalizeErrorCode,
} = require('./src/db/postgresCloudVerification');

function validEnv(overrides = {}) {
  return {
    RUN_003D_CLOUD_VERIFY: CLOUD_VERIFY_CONFIRMATION,
    USER_STORE_ADAPTER: 'sqlite',
    TENCENT_PG_HOST: '10.0.0.2',
    TENCENT_PG_PORT: '5432',
    TENCENT_PG_DATABASE: 'diet_secretary',
    TENCENT_PG_USER: 'diet_app',
    TENCENT_PG_PASSWORD: 'test-only-password',
    TENCENT_PG_SSL_MODE: 'require',
    ...overrides,
  };
}

function testPrivateAddressGuard() {
  for (const host of ['10.0.0.2', '172.16.0.1', '172.31.255.254', '192.168.20.3']) {
    assert.strictEqual(isPrivateIpv4(host), true, host);
  }
  for (const host of ['8.8.8.8', '172.32.0.1', 'example.com', '10.0.0.999', '10.0.0.2/path']) {
    assert.strictEqual(isPrivateIpv4(host), false, host);
  }
  assert.throws(
    () => assertCloudVerificationEnvironment(validEnv({ TENCENT_PG_HOST: '203.0.113.10' })),
    (error) => error.code === 'PRIVATE_IPV4_REQUIRED'
  );
  assert.throws(
    () => assertCloudVerificationEnvironment(validEnv({ TENCENT_PG_PORT: '6432' })),
    (error) => error.code === 'POSTGRES_PORT_MUST_BE_5432'
  );
}

function testExecutionGates() {
  assert.throws(
    () => assertCloudVerificationEnvironment(validEnv({ RUN_003D_CLOUD_VERIFY: '' })),
    (error) => error.code === 'VERIFY_CONFIRMATION_REQUIRED'
  );
  assert.throws(
    () => assertCloudVerificationEnvironment(validEnv({ USER_STORE_ADAPTER: 'tencent-postgres' })),
    (error) => error.code === 'USER_STORE_MUST_REMAIN_SQLITE'
  );
  assert.strictEqual(assertCloudVerificationEnvironment(validEnv()).user, 'diet_app');
}

function testDedicatedPoolConfig() {
  const config = assertCloudVerificationEnvironment(validEnv({
    TENCENT_PG_POOL_MAX: '20',
    TENCENT_PG_CONNECT_TIMEOUT_MS: '5000',
    TENCENT_PG_STATEMENT_TIMEOUT_MS: '10000',
  }));
  const verification = createVerificationConfig(config);
  assert.strictEqual(verification.poolMax, 1);
  assert.strictEqual(verification.connectTimeoutMs, 750);
  assert.strictEqual(verification.statementTimeoutMs, 5000);
  assert.strictEqual(config.poolMax, 20);
}

function testEvidenceIsStructured() {
  const lines = [];
  const recorder = createEvidenceRecorder({
    write: (line) => lines.push(line),
    now: () => new Date('2026-08-19T02:00:00.000Z'),
  });
  recorder.record('example', { backendPid: 1234, errorCode: '42501' });
  assert.deepStrictEqual(JSON.parse(lines[0]), {
    batch: '003d',
    check: 'example',
    status: 'PASS',
    at: '2026-08-19T02:00:00.000Z',
    backendPid: 1234,
    errorCode: '42501',
  });
  assert.strictEqual(recorder.checks.length, 1);
}

function testIdentifiersAndSafeCodes() {
  const ids = createVerificationIds();
  assert.match(ids.userA, /^acct:003d_a_[a-f0-9]{16}$/);
  assert.match(ids.ddlTable, /^dmc_003d_[a-f0-9]{16}$/);
  assert.strictEqual(normalizeErrorCode({ code: '42501' }), '42501');
  assert.strictEqual(normalizeErrorCode({ code: 'secret value with spaces' }), 'UNKNOWN');
  assert.strictEqual(normalizeErrorCode({}, 'POOL_CONNECT_TIMEOUT'), 'POOL_CONNECT_TIMEOUT');
  assert.strictEqual(normalizeErrorCode({}, 'unsafe fallback with spaces'), 'UNKNOWN');
  assert.throws(
    () => assertExpectedIdentity({ database_name: 'postgres', role_name: 'diet_app' }),
    (error) => error.code === 'VERIFY_DATABASE_IDENTITY_MISMATCH'
  );
}

function main() {
  testPrivateAddressGuard();
  testExecutionGates();
  testDedicatedPoolConfig();
  testEvidenceIsStructured();
  testIdentifiersAndSafeCodes();
  console.log('003d本地护栏测试通过：5组');
  console.log('003d真实云端脚本未执行：等待VPC证据、CloudBase Run环境变量和人工确认开关。');
}

main();
