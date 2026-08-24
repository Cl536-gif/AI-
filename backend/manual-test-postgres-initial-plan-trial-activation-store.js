const assert = require('assert');
const {
  createTencentPostgresUserStore,
} = require('./src/stores/tencentPostgresUserStore');

const userId = 'acct:004h_local_store';
const planId = 'plan-004h-local';
const calls = [];
const client = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (!sql.includes('activate_current_user_initial_plan_and_trial')) {
      throw new Error(`未覆盖的本地SQL：${sql}`);
    }
    return { rows: [{ result: JSON.stringify({
      planId,
      planVersion: 1,
      status: 'active',
      calculationId: 'calculation-004h-local',
      parentPlanId: null,
      plan: { label: '004h-local' },
      changeReason: 'initial_plan',
      createdAt: '2026-08-24T08:05:00.000Z',
      activatedAt: '2026-08-24T08:10:00.000Z',
      pausedAt: null,
      completedAt: null,
    }) }] };
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
  const activated = await store.activateInitialPlanAndTrial(userId, planId, {
    trialStartedAt: '2026-08-24T16:10:00+08:00',
    trialEndsAt: '2026-09-07T16:10:00+08:00',
    renewalReminderAt: '2026-09-06T16:10:00+08:00',
  });

  assert.strictEqual(activated.planId, planId);
  assert.strictEqual(activated.userId, userId);
  assert.strictEqual(activated.status, 'active');
  assert.strictEqual(activated.activatedAt, '2026-08-24T08:10:00.000Z');
  assert.deepStrictEqual(calls[0].params, [
    planId,
    '2026-08-24T08:10:00.000Z',
    '2026-09-07T08:10:00.000Z',
    '2026-09-06T08:10:00.000Z',
  ]);
  assert(calls[0].sql.includes('activate_current_user_initial_plan_and_trial'));

  await assert.rejects(
    store.activateInitialPlanAndTrial(userId, planId, {
      trialStartedAt: 'invalid',
      trialEndsAt: '2026-09-07T08:10:00Z',
      renewalReminderAt: '2026-09-06T08:10:00Z',
    }),
    /trialStartedAt格式不正确/
  );

  console.log(JSON.stringify({
    batch: '004h-adapter-local',
    status: 'PASS',
    methodCount: 1,
    networkUsed: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
