const assert = require('assert');
const {
  withPostgresClient,
  withUserTransaction,
} = require('./src/db/postgresTransaction');

const transactionConfig = Object.freeze({
  statementTimeoutMs: 10000,
  lockTimeoutMs: 3000,
  idleTransactionTimeoutMs: 15000,
});

class FakeClient {
  constructor({ failSql, delayedSql } = {}) {
    this.failSql = failSql;
    this.delayedSql = delayedSql;
    this.events = [];
    this.releaseCalls = [];
    this.resolveDelayedQuery = null;
  }

  async query(text, values) {
    this.events.push({ type: 'query', text, values });
    if (this.failSql && this.failSql === text) {
      throw new Error(`forced failure: ${text}`);
    }
    if (this.delayedSql && this.delayedSql === text) {
      return new Promise((resolve) => {
        this.resolveDelayedQuery = () => resolve({ rows: [{ delayed: true }] });
      });
    }
    return { rows: [{ ok: true }] };
  }

  release(error) {
    this.releaseCalls.push(error || null);
    this.events.push({ type: 'release', error: error || null });
  }
}

class FakePool {
  constructor(client) {
    this.client = client;
    this.connectCalls = 0;
  }

  async connect() {
    this.connectCalls += 1;
    this.client.events.push({ type: 'connect' });
    return this.client;
  }
}

function transactionOptions(client) {
  return { pool: new FakePool(client), config: transactionConfig };
}

async function testSuccessfulTransaction() {
  const client = new FakeClient();
  let leakedClient;
  const result = await withUserTransaction(
    '  anon:test-user  ',
    async (scopedClient) => {
      leakedClient = scopedClient;
      assert.strictEqual(scopedClient.release, undefined);
      assert.strictEqual(scopedClient.connect, undefined);
      const queryResult = await scopedClient.query(
        'SELECT event_id FROM app.user_events WHERE user_id = $1',
        ['anon:test-user']
      );
      assert.strictEqual(queryResult.rows[0].ok, true);
      return 'transaction-result';
    },
    transactionOptions(client)
  );

  assert.strictEqual(result, 'transaction-result');
  assert.deepStrictEqual(
    client.events.map((event) => event.type === 'query' ? event.text : event.type),
    [
      'connect',
      'BEGIN',
      "SELECT set_config('app.user_id', $1, true)",
      "SET LOCAL statement_timeout = '10000ms'",
      "SET LOCAL lock_timeout = '3000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '15000ms'",
      'SELECT event_id FROM app.user_events WHERE user_id = $1',
      'COMMIT',
      'release',
    ]
  );
  assert.deepStrictEqual(client.events[2].values, ['anon:test-user']);
  assert.deepStrictEqual(client.events[6].values, ['anon:test-user']);
  assert.deepStrictEqual(client.releaseCalls, [null]);
  await assert.rejects(
    leakedClient.query('SELECT 1', []),
    /回调已结束/
  );
}

async function testInvalidUserRejectedBeforeConnect() {
  const client = new FakeClient();
  const pool = new FakePool(client);
  await assert.rejects(
    withUserTransaction('bad user id', async () => {}, { pool, config: transactionConfig }),
    /userId格式不正确/
  );
  assert.strictEqual(pool.connectCalls, 0);
}

async function testValidationBeforePoolAcquisition() {
  const client = new FakeClient();
  const pool = new FakePool(client);
  await assert.rejects(
    withPostgresClient(null, { pool }),
    /数据库回调必须是函数/
  );
  assert.strictEqual(pool.connectCalls, 0);

  await assert.rejects(
    withUserTransaction('acct:test-user', async () => {}, {
      pool,
      config: { ...transactionConfig, statementTimeoutMs: 0 },
    }),
    /statementTimeoutMs 必须在 100—120000 之间/
  );
  assert.strictEqual(pool.connectCalls, 0);

  await assert.rejects(
    withUserTransaction('acct:test-user', async () => {}, {
      pool,
      config: { ...transactionConfig, lockTimeoutMs: 30001 },
    }),
    /lockTimeoutMs 必须在 100—30000 之间/
  );
  assert.strictEqual(pool.connectCalls, 0);

  const invalidReleaseCalls = [];
  const invalidClient = {
    release(error) { invalidReleaseCalls.push(error); },
  };
  const invalidPool = {
    async connect() { return invalidClient; },
  };
  await assert.rejects(
    withPostgresClient(async () => {}, { pool: invalidPool }),
    /无效的PostgreSQL客户端/
  );
  assert.strictEqual(invalidReleaseCalls.length, 1);
  assert(invalidReleaseCalls[0] instanceof Error);
}

async function testBusinessFailureRollsBack() {
  const client = new FakeClient();
  const original = new Error('business failed');
  await assert.rejects(
    withUserTransaction('acct:test-user', async () => { throw original; }, transactionOptions(client)),
    (error) => error === original
  );
  assert.deepStrictEqual(
    client.events.map((event) => event.type === 'query' ? event.text : event.type).slice(-2),
    ['ROLLBACK', 'release']
  );
  assert.deepStrictEqual(client.releaseCalls, [null]);
}

async function testSetupAndCommitFailuresRollBack() {
  const contextSql = "SELECT set_config('app.user_id', $1, true)";
  const setupClient = new FakeClient({ failSql: contextSql });
  await assert.rejects(
    withUserTransaction('acct:test-user', async () => {}, transactionOptions(setupClient)),
    /forced failure: SELECT set_config/
  );
  assert.strictEqual(setupClient.events.some((event) => event.text === 'ROLLBACK'), true);
  assert.deepStrictEqual(setupClient.releaseCalls, [null]);

  const commitClient = new FakeClient({ failSql: 'COMMIT' });
  await assert.rejects(
    withUserTransaction('acct:test-user', async () => 'result', transactionOptions(commitClient)),
    /forced failure: COMMIT/
  );
  assert.strictEqual(commitClient.events.some((event) => event.text === 'ROLLBACK'), true);
  assert.deepStrictEqual(commitClient.releaseCalls, [null]);
}

async function testRollbackFailureDestroysConnection() {
  const client = new FakeClient({ failSql: 'ROLLBACK' });
  const original = new Error('business failed before rollback');
  await assert.rejects(
    withUserTransaction('acct:test-user', async () => { throw original; }, transactionOptions(client)),
    (error) => (
      error === original
      && error.rollbackError instanceof Error
      && /forced failure: ROLLBACK/.test(error.rollbackError.message)
    )
  );
  assert.strictEqual(client.releaseCalls.length, 1);
  assert.strictEqual(client.releaseCalls[0], original.rollbackError);
}

async function testBeginFailureDestroysConnection() {
  const client = new FakeClient({ failSql: 'BEGIN' });
  await assert.rejects(
    withUserTransaction('acct:test-user', async () => {}, transactionOptions(client)),
    /forced failure: BEGIN/
  );
  assert.strictEqual(client.events.some((event) => event.text === 'ROLLBACK'), false);
  assert(client.releaseCalls[0] instanceof Error);
}

async function testForbiddenBusinessSqlRollsBack() {
  const forbiddenQueries = [
    ['BEGIN', []],
    ["SELECT set_config('app.user_id', $1, true)", ['acct:forged']],
    ['SET app.user_id = $1', ['acct:forged']],
    ['SELECT 1; SELECT 2', []],
    ['SELECT 1 -- hidden statement', []],
  ];

  for (const [sql, values] of forbiddenQueries) {
    const client = new FakeClient();
    await assert.rejects(
      withUserTransaction(
        'acct:test-user',
        async (scopedClient) => scopedClient.query(sql, values),
        transactionOptions(client)
      ),
      /不能|只允许/
    );
    const businessSqlReachedRawClient = client.events.some((event) => (
      event.type === 'query'
      && event.text === sql
      && Array.isArray(event.values)
      && JSON.stringify(event.values) === JSON.stringify(values)
    ));
    assert.strictEqual(businessSqlReachedRawClient, false);
    assert.strictEqual(client.events.some((event) => event.text === 'ROLLBACK'), true);
    assert.deepStrictEqual(client.releaseCalls, [null]);
  }
}

async function testUnawaitedQueryRollsBack() {
  const client = new FakeClient({ delayedSql: 'SELECT delayed_value FROM app.test' });
  const transactionPromise = withUserTransaction(
    'acct:test-user',
    async (scopedClient) => {
      scopedClient.query('SELECT delayed_value FROM app.test', []);
      return 'should-not-commit';
    },
    transactionOptions(client)
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(typeof client.resolveDelayedQuery, 'function');
  client.resolveDelayedQuery();
  await assert.rejects(transactionPromise, /仍有未等待完成的查询/);
  assert.strictEqual(client.events.some((event) => event.text === 'COMMIT'), false);
  assert.strictEqual(client.events.some((event) => event.text === 'ROLLBACK'), true);
  assert.deepStrictEqual(client.releaseCalls, [null]);
}

async function testUnawaitedRejectedQueryRollsBack() {
  const failedSql = 'SELECT rejected_value FROM app.test';
  const client = new FakeClient({ failSql: failedSql });
  await assert.rejects(
    withUserTransaction(
      'acct:test-user',
      async (scopedClient) => {
        scopedClient.query(failedSql, []);
        await new Promise((resolve) => setImmediate(resolve));
        return 'must-not-commit';
      },
      transactionOptions(client)
    ),
    /forced failure: SELECT rejected_value/
  );
  assert.strictEqual(client.events.some((event) => event.text === 'COMMIT'), false);
  assert.strictEqual(client.events.some((event) => event.text === 'ROLLBACK'), true);
  assert.deepStrictEqual(client.releaseCalls, [null]);
}

async function testPlainClientScope() {
  const client = new FakeClient();
  const pool = new FakePool(client);
  let leakedClient;
  const result = await withPostgresClient(async (scopedClient) => {
    leakedClient = scopedClient;
    return scopedClient.query('SELECT 1', []);
  }, { pool });
  assert.strictEqual(result.rows[0].ok, true);
  assert.deepStrictEqual(client.releaseCalls, [null]);
  assert.strictEqual(client.events.some((event) => /set_config/i.test(event.text || '')), false);
  await assert.rejects(leakedClient.query('SELECT 1', []), /回调已结束/);
}

async function testSequentialUsersDoNotShareContext() {
  const client = new FakeClient();
  const pool = new FakePool(client);
  await withUserTransaction(
    'anon:user-a',
    async (scopedClient) => scopedClient.query('SELECT current_setting($1, true)', ['app.user_id']),
    { pool, config: transactionConfig }
  );
  await withUserTransaction(
    'acct:user-b',
    async (scopedClient) => scopedClient.query('SELECT current_setting($1, true)', ['app.user_id']),
    { pool, config: transactionConfig }
  );

  const contextBindings = client.events
    .filter((event) => event.text === "SELECT set_config('app.user_id', $1, true)")
    .map((event) => event.values[0]);
  assert.deepStrictEqual(contextBindings, ['anon:user-a', 'acct:user-b']);
  assert.strictEqual(client.events.filter((event) => event.text === 'BEGIN').length, 2);
  assert.strictEqual(client.events.filter((event) => event.text === 'COMMIT').length, 2);
  assert.strictEqual(client.events.some((event) => /^SET\s+app\.user_id/i.test(event.text || '')), false);
  assert.deepStrictEqual(client.releaseCalls, [null, null]);
}

async function main() {
  await testSuccessfulTransaction();
  await testInvalidUserRejectedBeforeConnect();
  await testValidationBeforePoolAcquisition();
  await testBusinessFailureRollsBack();
  await testSetupAndCommitFailuresRollBack();
  await testRollbackFailureDestroysConnection();
  await testBeginFailureDestroysConnection();
  await testForbiddenBusinessSqlRollsBack();
  await testUnawaitedQueryRollsBack();
  await testUnawaitedRejectedQueryRollsBack();
  await testPlainClientScope();
  await testSequentialUsersDoNotShareContext();

  console.log('PASS: strict transaction ordering and parameterized user context');
  console.log('PASS: invalid user rejected before pool acquisition');
  console.log('PASS: callback/config/client validation occurs before safe reuse');
  console.log('PASS: business/setup errors rollback or destroy the connection');
  console.log('PASS: context binding and commit failures rollback safely');
  console.log('PASS: rollback failure releases with error and removes the connection');
  console.log('PASS: callback cannot control transactions/session context');
  console.log('PASS: callback client expires and unawaited pending/rejected queries force rollback');
  console.log('PASS: plain client scope releases exactly once');
  console.log('PASS: sequential users bind transaction-local contexts without session SET');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
