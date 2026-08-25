const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { calculateAndRecordAdultEnergy } = require('./src/services/energyCalculationService');
const { selectLongTermService, confirmLongTermProfile } = require('./src/services/longTermService');
const {
  createStagePlanDraft,
  markOfficialPlanDelivered,
  pausePlanForInterruption,
  resumeSamePlan,
} = require('./src/services/stagePlanService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectError(action, pattern, message) {
  let matched = false;
  try { await action(); } catch (err) { matched = pattern.test(err.message); }
  assert(matched, message);
}

function planInput(calculationId, label) {
  return {
    stageLabel: label,
    objective: '先建立规律且可执行的食堂饮食结构',
    durationDays: 14,
    energyCalculationId: calculationId,
    mealGuidance: [
      { mealType: 'lunch', guidance: '一份主食、一份蛋白质和一份蔬菜，按实际反馈调整。' },
      { mealType: 'dinner', guidance: '沿用同样结构，不要求一次改变全部习惯。' },
    ],
    adjustmentRules: ['用户主动反馈额外运动后再结合实际情况调整', '中断后不追补或惩罚性减少饮食'],
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-stage-plan-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:66666666-6666-4666-8666-666666666666';
  const calculation = await calculateAndRecordAdultEnergy(userId, {
    equationSex: 'female', ageYears: 22, heightCm: 165, weightKg: 60, activityLevel: 'light',
  }, { store, now: '2026-08-05T09:00:00+08:00' });

  await expectError(
    () => createStagePlanDraft(userId, planInput(calculation.calculationId, '第一阶段'), { store }),
    /不能建立长期阶段计划/,
    '免费状态能够建立长期计划'
  );

  await selectLongTermService(userId, { store, now: '2026-08-05T09:10:00+08:00' });
  await confirmLongTermProfile(userId, { store, now: '2026-08-05T09:20:00+08:00' });
  const v1 = await createStagePlanDraft(userId, planInput(calculation.calculationId, '第一阶段'), {
    store,
    now: '2026-08-05T09:30:00+08:00',
  });
  assert(v1.status === 'draft' && v1.planVersion === 1, '第一版计划草稿错误');
  assert(store.getServiceStatus(userId).trialStartedAt === null, '仅创建计划草稿就提前启动体验');

  const activeV1 = await markOfficialPlanDelivered(userId, v1.planId, {
    store,
    deliveredAt: '2026-08-05T10:00:00+08:00',
  });
  assert(activeV1.status === 'active', '第一份正式计划发出后没有启用');
  assert(store.getServiceStatus(userId).status === 'trial_active', '第一份正式计划发出后没有启动体验');
  assert(store.getServiceStatus(userId).officialPlanId === v1.planId, '体验没有关联第一份正式计划');

  const paused = await pausePlanForInterruption(userId, '连续三天出差无法按食堂方案执行', {
    store,
    now: '2026-08-08T08:00:00+08:00',
  });
  assert(paused.status === 'paused', '计划中断后没有暂停');
  await expectError(
    () => resumeSamePlan(userId, v1.planId, { store, now: '2026-08-09T08:00:00+08:00' }),
    /用户确认/,
    '未获用户确认就恢复了原计划'
  );
  const resumed = await resumeSamePlan(userId, v1.planId, {
    store,
    userConfirmed: true,
    now: '2026-08-09T09:00:00+08:00',
  });
  assert(resumed.status === 'active', '用户确认后没有恢复原计划');

  const v2 = await createStagePlanDraft(userId, planInput(calculation.calculationId, '第二阶段'), {
    store,
    parentPlanId: v1.planId,
    changeReason: '根据一周饥饿反馈调整餐次结构',
    now: '2026-08-12T10:00:00+08:00',
  });
  const activeV2 = await markOfficialPlanDelivered(userId, v2.planId, {
    store,
    deliveredAt: '2026-08-12T10:05:00+08:00',
  });
  assert(activeV2.status === 'active' && activeV2.planVersion === 2, '第二版计划没有启用');
  assert(store.getPlan(userId, v1.planId).status === 'superseded', '旧计划没有被标记为已替换');
  assert(store.getActivePlan(userId).planId === v2.planId, '用户出现多个或错误的活动计划');
  assert(store.listPlans(userId).length === 2, '计划版本历史数量错误');
  assert(store.listPlanTransitions(userId, v1.planId).some((item) => item.toStatus === 'paused'), '暂停历史没有保留');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 免费用户不能建立长期阶段计划');
  console.log('✅ 草稿不计时，第一份正式方案发出后才启动14天体验');
  console.log('✅ 中断会暂停计划，未经用户确认不能恢复');
  console.log('✅ 新版本关联旧版本和调整原因，并自动替换旧活动计划');
  console.log('✅ 每次计划状态变化保留完整历史且同一用户只有一个活动计划');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
