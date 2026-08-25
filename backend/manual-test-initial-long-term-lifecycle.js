const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { selectLongTermService } = require('./src/services/longTermService');
const {
  buildInitialLongTermPlanCommand,
} = require('./src/langgraph/nodes/finalizeInitialLongTermPlan');
const { parseActivityLevel } = require('./src/langgraph/nodes/preparePlanRevision');
const {
  persistInitialLongTermPlan,
} = require('./src/services/graphPersistenceCoordinator');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectError(action, pattern, message) {
  let matched = false;
  try { await action(); } catch (err) { matched = pattern.test(err.message); }
  assert(matched, message);
}

function readyState(overrides = {}) {
  return {
    serviceTier: 'subscribed',
    equationSex: 'female',
    bodyOnboardingStatus: 'completed',
    cycleOnboardingStatus: 'completed',
    bodyProfile: {
      ageYears: 22,
      heightCm: 165,
      currentWeightKg: 60,
      targetWeightKg: 55,
      dailyActivity: '平时上课久坐为主',
    },
    initialMealPlanText: '午餐选择一拳杂粮饭、一掌蔬菜和一份鸡腿，按实际饱腹感反馈。',
    ...overrides,
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-initial-lifecycle-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:12121212-1212-4212-8212-121212121212';
  store.updateProfile(userId, {
    body: {
      equationSex: 'female', ageYears: 22, heightCm: 165,
      currentWeightKg: 60, targetWeightKg: 55, dailyActivity: '久坐',
    },
    diet: { scene: 'cafeteria', cafeteriaMode: 'self_select', goals: ['减脂'] },
  }, { now: '2026-08-05T09:00:00+08:00' });
  await selectLongTermService(userId, { store, now: '2026-08-05T09:01:00+08:00' });

  assert(parseActivityLevel('sedentary') === 'light', '结构化的久坐枚举不能进入轻活动计算档');
  assert(parseActivityLevel('moderately_active') === 'moderate', '结构化的中活动枚举不能进入中活动计算档');

  await expectError(
    () => buildInitialLongTermPlanCommand(readyState({ equationSex: 'male' })),
    /只支持.*生理女性/,
    '男性能够建立长期方案命令'
  );
  await expectError(
    () => buildInitialLongTermPlanCommand(readyState({ bodyOnboardingStatus: 'partial' })),
    /身体资料尚未完成/,
    '身体资料不完整能够建立长期方案命令'
  );

  const command = buildInitialLongTermPlanCommand(readyState());
  const first = await persistInitialLongTermPlan(userId, command, {
    store, now: '2026-08-05T10:00:00+08:00',
  });
  const service = store.getServiceStatus(userId);
  assert(first.status === 'delivered' && first.plan.status === 'active', '首个正式方案没有交付并启用');
  assert(service.status === 'trial_active', '正式方案交付后没有启动体验');
  assert(service.trialStartedAt === '2026-08-05T02:00:00.000Z', '体验开始时间不是正式交付时刻');
  assert(service.trialEndsAt === '2026-08-19T02:00:00.000Z', '体验结束时间不是14天后');
  assert(service.renewalReminderAt === '2026-08-18T02:00:00.000Z', '续费提醒不是第13天');
  assert(store.listEnergyCalculations(userId).length === 1, '没有保存一次能量计算审计');
  assert(store.listPlans(userId).length === 1, '没有保存一份正式方案');

  const duplicate = await persistInitialLongTermPlan(userId, command, {
    store, now: '2026-08-05T10:01:00+08:00',
  });
  assert(duplicate.plan.planId === first.plan.planId, '重复请求生成了另一份正式方案');
  assert(store.listEnergyCalculations(userId).length === 1, '重复请求新增了计算记录');
  assert(store.listPlans(userId).length === 1, '重复请求新增了方案版本');
  assert(store.getServiceStatus(userId).trialStartedAt === service.trialStartedAt, '重复请求重置了试用开始时间');

  const failedUserId = 'anon:34343434-3434-4434-8434-343434343434';
  store.updateProfile(failedUserId, {
    body: { equationSex: 'female', ageYears: 22, heightCm: 165, currentWeightKg: 60, dailyActivity: '久坐' },
  });
  await selectLongTermService(failedUserId, { store });
  const invalidCommand = buildInitialLongTermPlanCommand(readyState());
  invalidCommand.energyInput.ageYears = 17;
  await expectError(
    () => persistInitialLongTermPlan(failedUserId, invalidCommand, { store }),
    /仅支持18至79岁/,
    '无效计算数据没有阻止正式方案'
  );
  assert(store.getServiceStatus(failedUserId).status !== 'trial_active', '计算失败仍启动了体验');
  assert(store.listPlans(failedUserId).length === 0, '计算失败仍保存了计划');

  const retryUserId = 'anon:56565656-5656-4656-8656-565656565656';
  store.updateProfile(retryUserId, {
    body: { equationSex: 'female', ageYears: 22, heightCm: 165, currentWeightKg: 60, dailyActivity: '久坐' },
  });
  await selectLongTermService(retryUserId, { store });
  let deliveryAttempts = 0;
  const failOnceStore = Object.create(store);
  failOnceStore.activateInitialPlanAndTrial = (...args) => {
    deliveryAttempts += 1;
    if (deliveryAttempts === 1) throw new Error('模拟正式交付失败');
    return store.activateInitialPlanAndTrial(...args);
  };
  await expectError(
    () => persistInitialLongTermPlan(retryUserId, command, { store: failOnceStore }),
    /模拟正式交付失败/,
    '模拟交付失败没有向上抛出'
  );
  assert(store.getServiceStatus(retryUserId).status === 'profile_confirmed', '交付失败仍启动了体验');
  assert(store.listPlans(retryUserId).length === 1 && store.listPlans(retryUserId)[0].status === 'draft', '交付失败没有保留可重试草稿');
  const retried = await persistInitialLongTermPlan(retryUserId, command, { store: failOnceStore });
  assert(retried.plan.status === 'active', '交付重试没有启用原草稿');
  assert(store.listPlans(retryUserId).length === 1, '交付重试重复创建了计划');
  assert(store.listEnergyCalculations(retryUserId).length === 1, '交付重试重复计算了能量');
  assert(store.getServiceStatus(retryUserId).status === 'trial_active', '交付重试成功后没有启动体验');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 仅女性且身体、经期资料完整时生成首个长期方案命令');
  console.log('✅ 计算、建计划、正式交付后才启动14天体验并安排第13天提醒');
  console.log('✅ 重复请求不新增计算、方案或重置试用时间');
  console.log('✅ 计算失败不会生成计划或启动体验');
  console.log('✅ 正式交付失败不启动体验，重试复用原计算和草稿');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
