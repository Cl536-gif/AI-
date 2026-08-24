const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULTS,
  parsePostgresPoolConfig,
  redactPostgresPoolConfig,
} = require('./src/db/postgresPoolConfig');
const {
  APPLICATION_NAME,
  createPostgresPool,
  getPostgresPool,
  resetPostgresPoolForTests,
} = require('./src/db/postgresPool');

const validEnv = Object.freeze({
  TENCENT_PG_HOST: '10.0.0.2',
  TENCENT_PG_DATABASE: 'diet_secretary',
  TENCENT_PG_USER: 'diet_app',
  TENCENT_PG_PASSWORD: 'test-password-with-special-!@#',
});

function assertConfigRejected(patch, expectedMessage) {
  assert.throws(
    () => parsePostgresPoolConfig({ ...validEnv, ...patch }),
    expectedMessage
  );
}

class FakePool {
  constructor(options) {
    this.options = options;
  }
}

function main() {
  const config = parsePostgresPoolConfig(validEnv);
  assert.strictEqual(config.host, '10.0.0.2');
  assert.strictEqual(config.port, DEFAULTS.port);
  assert.strictEqual(config.database, 'diet_secretary');
  assert.strictEqual(config.user, 'diet_app');
  assert.strictEqual(config.password, validEnv.TENCENT_PG_PASSWORD);
  assert.strictEqual(config.sslMode, 'require');
  assert.strictEqual(config.ssl.rejectUnauthorized, false);
  assert.strictEqual(config.poolMax, DEFAULTS.poolMax);
  assert(Object.isFrozen(config));

  const preservedPassword = parsePostgresPoolConfig({
    ...validEnv,
    TENCENT_PG_PASSWORD: ' password-with-edge-spaces ',
  });
  assert.strictEqual(preservedPassword.password, ' password-with-edge-spaces ');

  assertConfigRejected({ TENCENT_PG_HOST: '' }, /TENCENT_PG_HOST/);
  assertConfigRejected({ TENCENT_PG_HOST: 'postgres:\/\/10.0.0.2' }, /单独的主机名或IP地址/);
  assertConfigRejected({ TENCENT_PG_PORT: '5432x' }, /十进制整数/);
  assertConfigRejected({ TENCENT_PG_PORT: '65536' }, /1—65535/);
  assertConfigRejected({ TENCENT_PG_DATABASE: 'postgres' }, /diet_secretary/);
  assertConfigRejected({ TENCENT_PG_USER: 'admin_rag' }, /diet_app/);
  assertConfigRejected({ TENCENT_PG_USER: 'diet_owner' }, /diet_app/);
  assertConfigRejected({ TENCENT_PG_PASSWORD: '' }, /TENCENT_PG_PASSWORD/);
  assertConfigRejected({ TENCENT_PG_POOL_MAX: '21' }, /1—20/);
  assertConfigRejected({ TENCENT_PG_CONNECT_TIMEOUT_MS: '0' }, /250—30000/);
  assertConfigRejected({ TENCENT_PG_SSL_MODE: 'prefer' }, /disable、require、verify-full/);
  assertConfigRejected({
    TENCENT_PG_SSL_MODE: 'require',
    TENCENT_PG_SSL_CA_BASE64: 'unused',
  }, /只有 verify-full/);
  assertConfigRejected({ TENCENT_PG_SSL_MODE: 'verify-full' }, /必须配置/);
  assertConfigRejected({
    TENCENT_PG_SSL_MODE: 'verify-full',
    TENCENT_PG_SSL_CA_BASE64: 'not-base64',
  }, /有效的Base64证书/);

  const fakePem = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n';
  const verifiedConfig = parsePostgresPoolConfig({
    ...validEnv,
    TENCENT_PG_SSL_MODE: 'verify-full',
    TENCENT_PG_SSL_CA_BASE64: Buffer.from(fakePem).toString('base64'),
  });
  assert.strictEqual(verifiedConfig.ssl.rejectUnauthorized, true);
  assert.strictEqual(verifiedConfig.ssl.ca, fakePem);

  const disabledConfig = parsePostgresPoolConfig({
    ...validEnv,
    TENCENT_PG_SSL_MODE: 'disable',
  });
  assert.strictEqual(disabledConfig.ssl, false);

  const redacted = redactPostgresPoolConfig(verifiedConfig);
  assert.strictEqual(redacted.password, '[REDACTED]');
  assert.strictEqual(redacted.ssl.ca, '[REDACTED]');
  assert(!JSON.stringify(redacted).includes(validEnv.TENCENT_PG_PASSWORD));
  assert(!JSON.stringify(redacted).includes(fakePem));

  const pool = createPostgresPool({ config, PoolClass: FakePool });
  assert.strictEqual(pool.options.host, '10.0.0.2');
  assert.strictEqual(pool.options.user, 'diet_app');
  assert.strictEqual(pool.options.max, 5);
  assert.strictEqual(pool.options.application_name, APPLICATION_NAME);
  assert.strictEqual(pool.options.statementTimeoutMs, undefined);

  resetPostgresPoolForTests();
  const singletonA = getPostgresPool({ config, PoolClass: FakePool });
  const singletonB = getPostgresPool({ config, PoolClass: FakePool });
  assert.strictEqual(singletonA, singletonB);
  resetPostgresPoolForTests();

  const envExample = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
  assert(envExample.includes('USER_STORE_ADAPTER=sqlite'));
  assert(envExample.includes('TENCENT_PG_HOST='));
  assert(envExample.includes('TENCENT_PG_USER=diet_app'));
  assert(!envExample.includes('POLARDB_SUPABASE_'));

  console.log('PASS: TENCENT_PG configuration defaults and strict bounds');
  console.log('PASS: fixed database/user guard rejects admin and owner roles');
  console.log('PASS: explicit SSL modes and verify-full CA validation');
  console.log('PASS: password and CA redaction');
  console.log('PASS: lazy pool construction and singleton reuse without network access');
  console.log('PASS: active env template uses sqlite + TENCENT_PG_* only');
}

try {
  main();
} catch (error) {
  resetPostgresPoolForTests();
  console.error(error);
  process.exitCode = 1;
}
