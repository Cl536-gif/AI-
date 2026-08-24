const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  READINESS_SQL,
  checkPostgresReadiness,
  createPostgresReadinessHandler,
} = require('./src/db/postgresReadiness');
const {
  closePostgresPool,
  createPostgresPool,
  getPostgresPool,
  resetPostgresPoolForTests,
} = require('./src/db/postgresPool');
const {
  classifyPostgresError,
  safePostgresErrorDetails,
} = require('./src/db/postgresDiagnostics');
const { createGracefulShutdown } = require('./src/serverLifecycle');

const poolConfig = Object.freeze({
  host: '10.0.0.2',
  port: 5432,
  database: 'diet_secretary',
  user: 'diet_app',
  password: 'never-log-this-password',
  ssl: false,
  poolMax: 2,
  idleTimeoutMs: 30000,
  connectTimeoutMs: 5000,
});

class FakeReadinessClient {
  constructor({ row, queryError } = {}) {
    this.row = row || {
      database_name: 'diet_secretary',
      role_name: 'diet_app',
      user_context: null,
    };
    this.queryError = queryError;
    this.queryCalls = [];
    this.releaseCalls = [];
  }

  async query(config) {
    this.queryCalls.push(config);
    if (this.queryError) throw this.queryError;
    return { rows: [this.row] };
  }

  release(error) {
    this.releaseCalls.push(error || null);
  }
}

class FakeReadinessPool {
  constructor(client) {
    this.client = client;
    this.connectCalls = 0;
  }

  async connect() {
    this.connectCalls += 1;
    return this.client;
  }
}

function createLogger() {
  const entries = [];
  return {
    entries,
    error(...args) { entries.push(['error', ...args]); },
    log(...args) { entries.push(['log', ...args]); },
  };
}

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function testReadinessSuccess() {
  const client = new FakeReadinessClient();
  const result = await checkPostgresReadiness({
    pool: new FakeReadinessPool(client),
    timeoutMs: 750,
  });
  assert.deepStrictEqual(result, { ready: true });
  assert.strictEqual(client.queryCalls.length, 1);
  assert.strictEqual(client.queryCalls[0].text, READINESS_SQL);
  assert.deepStrictEqual(client.queryCalls[0].values, []);
  assert.strictEqual(client.queryCalls[0].query_timeout, 750);
  assert.deepStrictEqual(client.releaseCalls, [null]);
}

async function testReadinessMismatchDestroysConnection() {
  for (const row of [
    { database_name: 'postgres', role_name: 'diet_app', user_context: null },
    { database_name: 'diet_secretary', role_name: 'diet_owner', user_context: null },
    { database_name: 'diet_secretary', role_name: 'diet_app', user_context: 'acct:leaked' },
  ]) {
    const client = new FakeReadinessClient({ row });
    await assert.rejects(
      checkPostgresReadiness({ pool: new FakeReadinessPool(client) }),
      (error) => error.code === 'READINESS_IDENTITY_MISMATCH'
    );
    assert.strictEqual(client.releaseCalls.length, 1);
    assert(client.releaseCalls[0] instanceof Error);
  }
}

async function testReadinessHandlerIsGenericAndRedacted() {
  const secret = 'postgres://diet_app:secret@10.0.0.2/diet_secretary';
  const queryError = new Error(`connection failed: ${secret}`);
  queryError.code = 'ECONNREFUSED';
  const client = new FakeReadinessClient({ queryError });
  const logger = createLogger();
  const handler = createPostgresReadinessHandler({
    logger,
    check: () => checkPostgresReadiness({ pool: new FakeReadinessPool(client) }),
  });
  const response = createResponse();
  await handler({}, response);

  assert.strictEqual(response.statusCode, 503);
  assert.deepStrictEqual(response.body, { status: 'not_ready' });
  const serialized = JSON.stringify({ response, logs: logger.entries });
  assert(!serialized.includes(secret));
  assert(!serialized.includes('10.0.0.2'));
  assert(!serialized.includes('secret'));
  assert(serialized.includes('ECONNREFUSED'));
  assert.strictEqual(client.releaseCalls[0], queryError);

  const successResponse = createResponse();
  await createPostgresReadinessHandler({ check: async () => ({ ready: true }) })({}, successResponse);
  assert.strictEqual(successResponse.statusCode, 200);
  assert.deepStrictEqual(successResponse.body, { status: 'ready' });
}

function testUnknownErrorsUseSafeDiagnosticCategories() {
  const cases = [
    ['The server does not support SSL connections', 'SSL_UNSUPPORTED'],
    ['self-signed certificate in certificate chain', 'TLS_CERTIFICATE_ERROR'],
    ['SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string', 'AUTHENTICATION_FAILED'],
    ['connect ECONNREFUSED 10.0.0.2:5432', 'CONNECTION_REFUSED'],
    ['connection timeout expired for secret.internal', 'CONNECTION_TIMEOUT'],
    ['getaddrinfo ENOTFOUND secret.internal', 'HOST_RESOLUTION_FAILED'],
    ['no pg_hba.conf entry for host "10.0.0.2"', 'ACCESS_RULE_REJECTED'],
    ['缺少必填环境变量 TENCENT_PG_PASSWORD', 'CONFIGURATION_ERROR'],
  ];

  for (const [message, expected] of cases) {
    const error = new Error(message);
    assert.strictEqual(classifyPostgresError(error), expected);
    const serialized = JSON.stringify(safePostgresErrorDetails(error, 'test_event'));
    assert(serialized.includes(expected));
    assert(!serialized.includes(message));
    assert(!serialized.includes('10.0.0.2'));
    assert(!serialized.includes('secret.internal'));
  }

  const nested = new Error('outer wrapper');
  nested.cause = new Error('The server does not support SSL connections');
  assert.strictEqual(classifyPostgresError(nested), 'SSL_UNSUPPORTED');

  const sqlState = new Error('password=do-not-log');
  sqlState.code = '28P01';
  assert.deepStrictEqual(
    safePostgresErrorDetails(sqlState, 'test_event'),
    { event: 'test_event', code: '28P01' }
  );
}

async function testPoolErrorListenerAndIdempotentClose() {
  const logger = createLogger();

  class FakeLifecyclePool {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.endCalls = 0;
    }

    on(name, handler) {
      this.handlers[name] = handler;
      return this;
    }

    async end() {
      this.endCalls += 1;
    }
  }

  const standalone = createPostgresPool({
    config: poolConfig,
    PoolClass: FakeLifecyclePool,
    logger,
  });
  const secretError = new Error('password=never-log-this-password host=10.0.0.2');
  secretError.code = '57P01';
  standalone.handlers.error(secretError);
  const logs = JSON.stringify(logger.entries);
  assert(logs.includes('57P01'));
  assert(!logs.includes('never-log-this-password'));
  assert(!logs.includes('10.0.0.2'));

  resetPostgresPoolForTests();
  const singleton = getPostgresPool({
    config: poolConfig,
    PoolClass: FakeLifecyclePool,
    logger,
  });
  const closeA = closePostgresPool();
  const closeB = closePostgresPool();
  assert.strictEqual(closeA, closeB);
  await closeA;
  assert.strictEqual(singleton.endCalls, 1);
  assert.throws(() => getPostgresPool({ config: poolConfig }), /正在关闭或已经关闭/);
  resetPostgresPoolForTests();
}

function createFakeProcess() {
  const handlers = {};
  return {
    handlers,
    once(name, handler) { handlers[name] = handler; },
    removeListener(name, handler) {
      if (handlers[name] === handler) delete handlers[name];
    },
  };
}

async function testGracefulShutdownIsBoundedAndIdempotent() {
  const processRef = createFakeProcess();
  const logger = createLogger();
  const exits = [];
  let closeCallback;
  let resourceCloseCalls = 0;
  const server = {
    closeCalls: 0,
    idleCloseCalls: 0,
    forcedCalls: 0,
    close(callback) {
      this.closeCalls += 1;
      closeCallback = callback;
    },
    closeIdleConnections() { this.idleCloseCalls += 1; },
    closeAllConnections() { this.forcedCalls += 1; },
  };
  const controller = createGracefulShutdown({
    server,
    processRef,
    logger,
    timeoutMs: 500,
    closeResources: async () => { resourceCloseCalls += 1; },
    exit: (code) => exits.push(code),
  });

  assert.strictEqual(typeof processRef.handlers.SIGTERM, 'function');
  assert.strictEqual(typeof processRef.handlers.SIGINT, 'function');
  const shutdownA = controller.shutdown('SIGTERM');
  const shutdownB = controller.shutdown('SIGINT');
  assert.strictEqual(shutdownA, shutdownB);
  assert.strictEqual(server.closeCalls, 1);
  assert.strictEqual(server.idleCloseCalls, 1);
  closeCallback();
  const result = await shutdownA;
  assert.deepStrictEqual(result, { status: 'closed' });
  assert.strictEqual(resourceCloseCalls, 1);
  assert.deepStrictEqual(exits, [0]);
  assert.strictEqual(server.forcedCalls, 0);
  controller.dispose();
  assert.deepStrictEqual(processRef.handlers, {});

  const timeoutExits = [];
  let timeoutResourceCloses = 0;
  const stuckServer = {
    forcedCalls: 0,
    close() {},
    closeAllConnections() { this.forcedCalls += 1; },
  };
  const timeoutController = createGracefulShutdown({
    server: stuckServer,
    processRef: createFakeProcess(),
    logger,
    timeoutMs: 100,
    closeResources: async () => { timeoutResourceCloses += 1; },
    exit: (code) => timeoutExits.push(code),
  });
  const timeoutResult = await timeoutController.shutdown('SIGTERM');
  assert.deepStrictEqual(timeoutResult, { status: 'timed_out' });
  assert.strictEqual(stuckServer.forcedCalls, 1);
  assert.strictEqual(timeoutResourceCloses, 1);
  assert.deepStrictEqual(timeoutExits, [1]);
}

function testServerWiringKeepsHealthSeparate() {
  const serverSource = fs.readFileSync(path.join(__dirname, 'src/server.js'), 'utf8');
  assert(serverSource.includes("app.get('/api/health'"));
  assert(serverSource.includes("app.get('/api/ready', createPostgresReadinessHandler())"));
  assert(serverSource.includes('createGracefulShutdown({ server })'));
}

async function main() {
  await testReadinessSuccess();
  await testReadinessMismatchDestroysConnection();
  await testReadinessHandlerIsGenericAndRedacted();
  testUnknownErrorsUseSafeDiagnosticCategories();
  await testPoolErrorListenerAndIdempotentClose();
  await testGracefulShutdownIsBoundedAndIdempotent();
  testServerWiringKeepsHealthSeparate();

  console.log('PASS: readiness uses a bounded query and verifies database, role, and empty user context');
  console.log('PASS: readiness mismatch or query failure destroys the borrowed connection');
  console.log('PASS: readiness responses and PostgreSQL diagnostics do not expose secrets');
  console.log('PASS: code-less PostgreSQL failures map to fixed redacted categories');
  console.log('PASS: idle pool errors are handled with allowlisted diagnostics');
  console.log('PASS: pool close is idempotent and blocks reuse after shutdown starts');
  console.log('PASS: SIGTERM/SIGINT shutdown drains HTTP, closes resources, and has a hard timeout');
  console.log('PASS: /api/health remains process-only and /api/ready is database-aware');
}

main().catch((error) => {
  resetPostgresPoolForTests();
  console.error(error);
  process.exitCode = 1;
});
