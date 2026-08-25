const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { calculateAndRecordAdultEnergy } = require('./src/services/energyCalculationService');
const { selectLongTermService, confirmLongTermProfile } = require('./src/services/longTermService');
const { createStagePlanDraft, markOfficialPlanDelivered, pausePlanForInterruption } = require('./src/services/stagePlanService');
const { persistPlanRevisionCommand } = require('./src/services/graphPersistenceCoordinator');

function assert(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-graph-revision-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await selectLongTermService(userId, { store, now: '2026-08-05T08:00:00+08:00' });
  await confirmLongTermProfile(userId, { store, now: '2026-08-05T08:05:00+08:00' });
  const calculation = await calculateAndRecordAdultEnergy(userId, {
    equationSex: 'female', ageYears: 22, heightCm: 165, weightKg: 60, activityLevel: 'light',
  }, { store, now: '2026-08-05T08:10:00+08:00' });
  const v1 = await createStagePlanDraft(userId, {
    stageLabel: '第一阶段', objective: '规律饮食', durationDays: 14,
    energyCalculationId: calculation.calculationId,
    mealGuidance: [{ mealType: 'general', guidance: '规律吃三餐。' }], adjustmentRules: [],
  }, { store, now: '2026-08-05T08:15:00+08:00' });
  await markOfficialPlanDelivered(userId, v1.planId, { store, deliveredAt: '2026-08-05T08:20:00+08:00' });
  await pausePlanForInterruption(userId, '课表改变', { store, now: '2026-08-06T08:00:00+08:00' });

  const persisted = await persistPlanRevisionCommand(userId, {
    commandId: 'command-1', parentPlanId: v1.planId,
    changes: [{ field: 'schedule', summary: '午休提前半小时' }],
    proposedPlan: {
      stageLabel: '第二阶段', objective: '适应新课表', durationDays: 14,
      mealGuidance: [{ mealType: 'general', guidance: '按新时间规律安排三餐。' }], adjustmentRules: [],
    },
    needsRecalculation: false,
    energyInput: calculation.inputs,
    userReply: '这是第二阶段完整方案。',
  }, { store, now: '2026-08-06T08:10:00+08:00' });
  assert(persisted.status === 'delivered' && persisted.plan.status === 'active', '草稿没有在持久化成功后正式启用');
  assert(persisted.plan.planVersion === 2, '新版版本号错误');
  assert(store.getPlan(userId, v1.planId).status === 'superseded', '旧暂停计划没有被替换');
  assert(store.listPlans(userId).length === 2, '持久化流程没有形成完整新旧版本');
  const repeated = await persistPlanRevisionCommand(userId, {
    commandId: 'command-1', parentPlanId: v1.planId,
    changes: [{ field: 'schedule', summary: '午休提前半小时' }],
    proposedPlan: {
      stageLabel: '第二阶段', objective: '适应新课表', durationDays: 14,
      mealGuidance: [{ mealType: 'general', guidance: '按新时间规律安排三餐。' }], adjustmentRules: [],
    },
    needsRecalculation: false, energyInput: calculation.inputs, userReply: '这是第二阶段完整方案。',
  }, { store, now: '2026-08-06T08:11:00+08:00' });
  assert(repeated.plan.planId === persisted.plan.planId, '相同commandId重复请求生成了不同计划');
  assert(store.listPlans(userId).length === 2, '相同命令重复持久化创建了额外版本');
  assert(store.getPlanRevisionCommand(userId, 'command-1').status === 'delivered', '命令交付状态没有保存');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ LangGraph草稿命令经业务层校验后创建并交付新版');
  console.log('✅ 持久化成功后新版激活、旧暂停版替换且版本历史完整');
  console.log('✅ 相同commandId重复请求返回原计划，不会重复建版');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
