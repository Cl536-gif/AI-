const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { calculateAndRecordAdultEnergy } = require('./src/services/energyCalculationService');
const { selectLongTermService, confirmLongTermProfile } = require('./src/services/longTermService');
const { createStagePlanDraft, markOfficialPlanDelivered } = require('./src/services/stagePlanService');
const {
  processPlanLifecycleFromEvents,
  processPlanRecoveryChoice,
} = require('./src/services/planAdjustmentService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function planInput(calculationId) {
  return {
    stageLabel: '第一阶段', objective: '建立规律饮食结构', durationDays: 14,
    energyCalculationId: calculationId,
    mealGuidance: [{ mealType: 'general', guidance: '主食、蛋白质和蔬菜合理搭配。' }],
    adjustmentRules: ['根据真实反馈调整'],
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-plan-adjustment-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:88888888-8888-4888-8888-888888888888';
  await selectLongTermService(userId, { store, now: '2026-08-05T08:00:00+08:00' });
  await confirmLongTermProfile(userId, { store, now: '2026-08-05T08:10:00+08:00' });
  const calculation = await calculateAndRecordAdultEnergy(userId, {
    equationSex: 'female', ageYears: 22, heightCm: 165, weightKg: 60, activityLevel: 'light',
  }, { store, now: '2026-08-05T08:20:00+08:00' });
  const plan = await createStagePlanDraft(userId, planInput(calculation.calculationId), {
    store, now: '2026-08-05T08:30:00+08:00',
  });
  await markOfficialPlanDelivered(userId, plan.planId, { store, deliveredAt: '2026-08-05T08:40:00+08:00' });

  const ordinary = await processPlanLifecycleFromEvents(userId, {
    status: 'recorded',
    recordedEvents: [{ eventType: 'exercise', payload: { summary: '跑步30分钟' } }],
  }, { store, now: '2026-08-06T18:00:00+08:00' });
  assert(ordinary.action === 'observe_only', '一次运动错误改动了长期计划');
  assert(store.getActivePlan(userId)?.planId === plan.planId, '普通事件导致活动计划消失');
  assert(store.listPlans(userId).length === 1, '普通反馈自动创建了新版计划');

  const interrupted = await processPlanLifecycleFromEvents(userId, {
    status: 'recorded',
    recordedEvents: [{
      eventType: 'plan_interruption',
      payload: { summary: '连续出差三天无法按食堂方案执行', reason: '连续出差三天' },
    }],
  }, { store, now: '2026-08-07T09:00:00+08:00' });
  assert(interrupted.action === 'plan_paused', '明确中断后没有暂停计划');
  assert(store.getPlan(userId, plan.planId).status === 'paused', '计划状态没有变成paused');
  assert(store.listPlans(userId).length === 1, '暂停计划时偷偷创建了新版本');
  assert(
    store.listPlanTransitions(userId, plan.planId).some((item) =>
      item.toStatus === 'paused' && item.reason.includes('连续出差三天')),
    '暂停原因没有进入计划状态审计'
  );

  const ambiguous = await processPlanRecoveryChoice(userId, '好的', {
    store, now: '2026-08-07T09:01:00+08:00',
  });
  assert(ambiguous.status === 'awaiting_choice' && ambiguous.action === 'none', '含糊回答自动恢复了计划');
  assert(store.getPlan(userId, plan.planId).status === 'paused', '含糊回答改变了暂停状态');

  const newVersion = await processPlanRecoveryChoice(userId, '按现在的情况重新调整方案', {
    store, now: '2026-08-07T09:02:00+08:00',
  });
  assert(newVersion.action === 'new_version_requested', '明确重做没有登记新版请求');
  assert(store.getPlan(userId, plan.planId).status === 'paused', '请求新版时提前恢复了旧计划');
  assert(store.listPlans(userId).length === 1, '请求新版时在完整方案生成前创建了草稿');

  const resumed = await processPlanRecoveryChoice(userId, '我想继续原来的计划', {
    store, now: '2026-08-07T09:03:00+08:00',
  });
  assert(resumed.action === 'plan_resumed', '明确继续原计划后没有恢复');
  assert(store.getActivePlan(userId)?.planId === plan.planId, '恢复后活动计划不正确');

  const failed = await processPlanLifecycleFromEvents(userId, {
    status: 'extraction_failed', recordedEvents: [],
  }, { store, now: '2026-08-07T09:05:00+08:00' });
  assert(failed.action === 'none' && failed.status === 'not_evaluated', '抽取失败仍然改变了计划');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 单餐、运动和普通反馈只记录观察，不改写或新建阶段计划');
  console.log('✅ 明确计划中断事件会暂停当前计划并保留原因审计');
  console.log('✅ 暂停不会自动创建新版，恢复原计划仍需用户后续确认');
  console.log('✅ 含糊回答不替用户决定，明确继续才恢复原计划');
  console.log('✅ 明确重做只登记新版请求，完整新方案交付前不创建或启用新版');
  console.log('✅ 事件抽取失败时不会误改计划状态');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
