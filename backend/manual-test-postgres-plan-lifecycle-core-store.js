const assert = require('assert');
const {
  createTencentPostgresUserStore,
} = require('./src/stores/tencentPostgresUserStore');

const userId = 'acct:004g_local_store';
const planId = 'plan-004g-local-v1';
const parentPlanId = 'plan-004g-local-parent';
const calculationId = 'calculation-004g-local';
const calls = [];

function row(overrides = {}) {
  return {
    plan_id: planId,
    plan_version: 1,
    status: 'draft',
    calculation_id: calculationId,
    parent_plan_id: parentPlanId,
    plan: { label: 'local-plan' },
    change_reason: 'local_test',
    created_at: new Date('2026-08-24T08:05:00.000Z'),
    activated_at: null,
    paused_at: null,
    completed_at: null,
    ...overrides,
  };
}

const client = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('create_current_user_plan_draft')) {
      return { rows: [{ result: row() }] };
    }
    if (sql.includes('transition_current_user_plan')) {
      return {
        rows: [{ result: JSON.stringify({
          planId,
          planVersion: 1,
          status: 'active',
          calculationId,
          parentPlanId,
          plan: { label: 'local-plan' },
          changeReason: 'local_test',
          createdAt: '2026-08-24T08:05:00.000Z',
          activatedAt: '2026-08-24T08:10:00.000Z',
          pausedAt: null,
          completedAt: null,
        }) }],
      };
    }
    if (sql.includes('FROM app.plan_state_transitions')) {
      return {
        rows: [{
          transition_id: 'transition-004g-local',
          from_status: 'draft',
          to_status: 'active',
          reason: 'local_activation',
          occurred_at: new Date('2026-08-24T08:10:00.000Z'),
        }],
      };
    }
    if (sql.includes('ORDER BY plan_version DESC')) {
      return { rows: [row({ plan_version: 2 }), row()] };
    }
    if (sql.includes("status = 'active'")) {
      return {
        rows: [row({
          status: 'active',
          activated_at: new Date('2026-08-24T08:10:00.000Z'),
        })],
      };
    }
    if (sql.includes('FROM app.user_plan_versions')) {
      return { rows: [row()] };
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
  const created = await store.createPlanDraft(userId, {
    calculationId,
    parentPlanId,
    plan: { label: 'local-plan' },
    changeReason: 'local_test',
    ignoredDomainField: true,
  }, { now: '2026-08-24T16:05:00+08:00' });
  assert.strictEqual(created.planId, planId);
  assert.strictEqual(created.planVersion, 1);
  assert.strictEqual(created.createdAt, '2026-08-24T08:05:00.000Z');

  const createCall = calls.find(({ sql }) => (
    sql.includes('create_current_user_plan_draft')
  ));
  assert.deepStrictEqual(JSON.parse(createCall.params[0]), {
    calculationId,
    parentPlanId,
    plan: { label: 'local-plan' },
    changeReason: 'local_test',
  });
  assert.strictEqual(createCall.params[1], '2026-08-24T08:05:00.000Z');

  const selected = await store.getPlan(userId, planId);
  const active = await store.getActivePlan(userId);
  const plans = await store.listPlans(userId, { limit: 999 });
  const transitioned = await store.transitionPlan(
    userId,
    planId,
    'active',
    { reason: 'local_activation', now: '2026-08-24T16:10:00+08:00' }
  );
  const transitions = await store.listPlanTransitions(userId, planId);

  assert.strictEqual(selected.parentPlanId, parentPlanId);
  assert.strictEqual(active.status, 'active');
  assert.strictEqual(active.activatedAt, '2026-08-24T08:10:00.000Z');
  assert.strictEqual(plans.length, 2);
  assert.strictEqual(plans[0].planVersion, 2);
  assert.strictEqual(
    calls.find(({ sql }) => sql.includes('ORDER BY plan_version DESC')).params[1],
    200
  );
  assert.strictEqual(transitioned.status, 'active');
  assert.strictEqual(transitioned.userId, userId);
  assert.deepStrictEqual(transitions[0], {
    transitionId: 'transition-004g-local',
    planId,
    userId,
    fromStatus: 'draft',
    toStatus: 'active',
    reason: 'local_activation',
    occurredAt: '2026-08-24T08:10:00.000Z',
  });

  await assert.rejects(
    store.createPlanDraft(userId, null),
    /计划草稿参数格式不正确/
  );

  console.log(JSON.stringify({
    batch: '004g-adapter-local',
    status: 'PASS',
    methodCount: 6,
    networkUsed: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
