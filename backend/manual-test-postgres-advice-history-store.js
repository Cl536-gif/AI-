const assert = require('assert');
const {
  createTencentPostgresUserStore,
} = require('./src/stores/tencentPostgresUserStore');

const userId = 'acct:004k_local_store';
const calls = [];
const rpcAdvice = {
  adviceId: 'advice-004k-local',
  userId,
  adviceType: 'initial_meal_plan',
  serviceMode: 'free',
  content: '早餐增加优质蛋白质',
  metadata: { source: 'local-test' },
  threadId: 'thread-004k-local',
  idempotencyKey: 'advice-key-004k-local',
  createdAt: '2026-08-25T08:00:00+00:00',
};

const client = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('record_current_user_advice')) {
      return { rows: [{ result: JSON.stringify(rpcAdvice) }] };
    }
    if (sql.includes('FROM app.user_advice_history')) {
      return { rows: [{
        advice_id: rpcAdvice.adviceId,
        advice_type: rpcAdvice.adviceType,
        service_mode: rpcAdvice.serviceMode,
        content: rpcAdvice.content,
        metadata: rpcAdvice.metadata,
        thread_id: rpcAdvice.threadId,
        idempotency_key: rpcAdvice.idempotencyKey,
        created_at: new Date(rpcAdvice.createdAt),
      }] };
    }
    throw new Error(`未覆盖的本地SQL：${sql}`);
  },
};

const store = createTencentPostgresUserStore({
  async runUserTransaction(transactionUserId, callback) {
    assert.strictEqual(transactionUserId, userId);
    return callback(client);
  },
  async runPostgresClient(callback) {
    return callback(client);
  },
});

async function run() {
  const recorded = await store.recordAdvice(userId, {
    adviceType: 'initial_meal_plan',
    serviceMode: 'free',
    content: '  早餐增加优质蛋白质  ',
    metadata: { source: 'local-test' },
    threadId: ' thread-004k-local ',
    idempotencyKey: ' advice-key-004k-local ',
    createdAt: '2026-08-25T16:00:00+08:00',
    ignoredDomainField: true,
  });
  assert.strictEqual(recorded.userId, userId);
  assert.strictEqual(recorded.createdAt, '2026-08-25T08:00:00.000Z');

  const history = await store.listAdviceHistory(userId, { limit: 999 });
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].adviceId, rpcAdvice.adviceId);
  assert.strictEqual(history[0].createdAt, '2026-08-25T08:00:00.000Z');

  const writeCall = calls.find(({ sql }) => sql.includes('record_current_user_advice'));
  assert.deepStrictEqual(JSON.parse(writeCall.params[0]), {
    adviceType: 'initial_meal_plan',
    serviceMode: 'free',
    content: '早餐增加优质蛋白质',
    metadata: { source: 'local-test' },
    threadId: 'thread-004k-local',
    idempotencyKey: 'advice-key-004k-local',
  });
  assert.deepStrictEqual(writeCall.params[1], '2026-08-25T08:00:00.000Z');
  const listCall = calls.find(({ sql }) => sql.includes('FROM app.user_advice_history'));
  assert.deepStrictEqual(listCall.params, [userId, 200]);

  await assert.rejects(
    store.recordAdvice(userId, { content: '', idempotencyKey: 'key' }),
    /建议内容不能为空/
  );
  await assert.rejects(
    store.recordAdvice(userId, { content: 'x', idempotencyKey: '' }),
    /建议幂等键不能为空/
  );
  await assert.rejects(
    store.recordAdvice(userId, { content: 'x', idempotencyKey: 'key', metadata: [] }),
    /建议元数据格式不正确/
  );
  await assert.rejects(
    store.recordAdvice(userId, {
      content: 'x',
      idempotencyKey: 'key',
      createdAt: 'invalid',
    }),
    /建议记录时间格式不正确/
  );

  console.log(JSON.stringify({
    batch: '004k-adapter-local',
    status: 'PASS',
    methodCount: 2,
    networkUsed: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
