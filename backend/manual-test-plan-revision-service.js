const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { calculateAndRecordAdultEnergy } = require('./src/services/energyCalculationService');
const { selectLongTermService, confirmLongTermProfile } = require('./src/services/longTermService');
const {
  createStagePlanDraft, markOfficialPlanDelivered, pausePlanForInterruption,
} = require('./src/services/stagePlanService');
const { createPlanRevisionDraft, deliverPlanRevision } = require('./src/services/planRevisionService');

function assert(condition, message) { if (!condition) throw new Error(message); }
async function expectError(action, pattern, message) {
  let matched = false;
  try { await action(); } catch (err) { matched = pattern.test(err.message); }
  assert(matched, message);
}

function proposedPlan(label = '第二阶段') {
  return {
    stageLabel: label,
    objective: '适配新的上课与食堂时间，继续保持规律饮食',
    durationDays: 14,
    mealGuidance: [{ mealType: 'general', guidance: '根据新时间安排三餐，不用追补中断的几天。' }],
    adjustmentRules: ['饥饿明显时先反馈，再调整加餐'],
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-plan-revision-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:99999999-9999-4999-8999-999999999999';
  await selectLongTermService(userId, { store, now: '2026-08-05T08:00:00+08:00' });
  await confirmLongTermProfile(userId, { store, now: '2026-08-05T08:05:00+08:00' });
  const initialCalculation = await calculateAndRecordAdultEnergy(userId, {
    equationSex: 'female', ageYears: 22, heightCm: 165, weightKg: 60, activityLevel: 'light',
  }, { store, now: '2026-08-05T08:10:00+08:00' });
  const v1 = await createStagePlanDraft(userId, {
    ...proposedPlan('第一阶段'), energyCalculationId: initialCalculation.calculationId,
  }, { store, now: '2026-08-05T08:15:00+08:00' });
  await markOfficialPlanDelivered(userId, v1.planId, { store, deliveredAt: '2026-08-05T08:20:00+08:00' });
  await pausePlanForInterruption(userId, '新学期课表改变', { store, now: '2026-08-10T08:00:00+08:00' });

  await expectError(() => createPlanRevisionDraft(userId, {
    userConfirmed: false, parentPlanId: v1.planId,
    changes: [{ field: 'schedule', summary: '新学期课表改变' }], proposedPlan: proposedPlan(),
  }, { store }), /用户明确确认/, '未经确认创建了新版草稿');

  const scheduleRevision = await createPlanRevisionDraft(userId, {
    userConfirmed: true, parentPlanId: v1.planId,
    changes: [{ field: 'schedule', summary: '午休时间提前半小时' }],
    proposedPlan: proposedPlan(),
  }, { store, now: '2026-08-10T08:10:00+08:00' });
  assert(!scheduleRevision.recalculated, '仅作息变化却重新进行了能量计算');
  assert(scheduleRevision.draft.calculationId === initialCalculation.calculationId, '作息变化没有沿用可追溯计算');
  assert(store.getPlan(userId, v1.planId).status === 'paused', '创建草稿时提前替换了旧计划');
  assert(store.getServiceStatus(userId).officialPlanId === v1.planId, '创建草稿时改变了正式计划关联');

  const activeV2 = await deliverPlanRevision(userId, scheduleRevision.draft.planId, {
    store, deliveredAt: '2026-08-10T08:20:00+08:00',
  });
  assert(activeV2.status === 'active', '正式交付后新版没有激活');
  assert(store.getPlan(userId, v1.planId).status === 'superseded', '新版交付后暂停旧版没有被替换');
  assert(store.listPlanTransitions(userId, v1.planId).some((item) => item.toStatus === 'superseded'), '旧版替换缺少审计');

  await pausePlanForInterruption(userId, '活动量长期增加', { store, now: '2026-08-12T08:00:00+08:00' });
  await expectError(() => createPlanRevisionDraft(userId, {
    userConfirmed: true, parentPlanId: activeV2.planId,
    changes: [{ field: 'activity_level', summary: '从久坐改为每天运动' }], proposedPlan: proposedPlan('第三阶段'),
  }, { store }), /完整计算输入/, '活动水平变化时沿用了旧计算');
  const activityRevision = await createPlanRevisionDraft(userId, {
    userConfirmed: true, parentPlanId: activeV2.planId,
    changes: [{ field: 'activity_level', summary: '从轻活动变为中活动' }],
    energyInput: { equationSex: 'female', ageYears: 22, heightCm: 165, weightKg: 60, activityLevel: 'moderate' },
    proposedPlan: proposedPlan('第三阶段'),
  }, { store, now: '2026-08-12T08:10:00+08:00' });
  assert(activityRevision.recalculated, '活动水平变化没有重新计算');
  assert(activityRevision.draft.calculationId !== initialCalculation.calculationId, '新版仍引用旧计算结果');
  assert(store.getPlan(userId, activeV2.planId).status === 'paused', '第三版草稿提前替换第二版');

  await expectError(() => createPlanRevisionDraft(userId, {
    userConfirmed: true, parentPlanId: activeV2.planId,
    changes: [{ field: 'health_status', summary: '近期出现不明原因持续胃痛' }], proposedPlan: proposedPlan('第三阶段'),
  }, { store }), /专业风险评估/, '健康状态变化被自动生成饮食计划');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 未经用户确认不会创建新版计划草稿');
  console.log('✅ 作息、食堂或口味变化沿用已有计算，草稿不提前替换旧版');
  console.log('✅ 身体或活动参数变化必须使用完整输入重新计算并保存审计');
  console.log('✅ 新版完整交付后才激活，并把暂停旧版标记为superseded');
  console.log('✅ 健康或疾病状态变化不会自动生成新版，必须先做风险评估');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
