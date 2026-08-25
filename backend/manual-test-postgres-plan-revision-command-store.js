const assert = require('assert');
const {
  createTencentPostgresUserStore,
} = require('./src/stores/tencentPostgresUserStore');

const userId = 'acct:004i_local_store';
const commandId = 'command-004i-local';
const planId = 'plan-004i-local';
const calls = [];

const client = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('record_current_user_plan_revision_command')) {
      return { rows: [{ result: JSON.stringify({
        commandId,
        planId,
        status: params[2],
        createdAt: '2026-08-25T04:00:00.000Z',
        updatedAt: params[3],
      }) }] };
    }
    if (sql.includes('FROM app.plan_revision_commands')) {
      return { rows: [{
        command_id: commandId,
        plan_id: planId,
        status: 'draft_created',
        created_at: new Date('2026-08-25T04:00:00.000Z'),
        updated_at: new Date('2026-08-25T04:01:00.000Z'),
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
  const selected = await store.getPlanRevisionCommand(userId, commandId);
  assert.deepStrictEqual(selected, {
    commandId,
    userId,
    planId,
    status: 'draft_created',
    createdAt: '2026-08-25T04:00:00.000Z',
    updatedAt: '2026-08-25T04:01:00.000Z',
  });

  const saved = await store.recordPlanRevisionCommand(userId, commandId, {
    planId,
    status: 'delivered',
    now: '2026-08-25T12:02:00+08:00',
  });
  assert.strictEqual(saved.userId, userId);
  assert.strictEqual(saved.commandId, commandId);
  assert.strictEqual(saved.planId, planId);
  assert.strictEqual(saved.status, 'delivered');
  assert.strictEqual(saved.updatedAt, '2026-08-25T04:02:00.000Z');

  const writeCall = calls.find(({ sql }) => (
    sql.includes('record_current_user_plan_revision_command')
  ));
  assert.deepStrictEqual(writeCall.params, [
    commandId,
    planId,
    'delivered',
    '2026-08-25T04:02:00.000Z',
  ]);

  await assert.rejects(
    store.recordPlanRevisionCommand(userId, commandId, {
      planId,
      status: 'invalid',
    }),
    /新版命令状态不正确/
  );
  await assert.rejects(
    store.recordPlanRevisionCommand(userId, commandId, {
      planId,
      status: 'draft_created',
      now: 'invalid',
    }),
    /新版计划命令时间格式不正确/
  );

  console.log(JSON.stringify({
    batch: '004i-adapter-local',
    status: 'PASS',
    methodCount: 2,
    networkUsed: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
