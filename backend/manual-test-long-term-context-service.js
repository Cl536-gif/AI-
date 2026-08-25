const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { recordUserConsent } = require('./src/services/userDataService');
const { calculateAndRecordAdultEnergy } = require('./src/services/energyCalculationService');
const { selectLongTermService, confirmLongTermProfile, expireTrialIfDue } = require('./src/services/longTermService');
const {
  createStagePlanDraft,
  markOfficialPlanDelivered,
  pausePlanForInterruption,
  resumeSamePlan,
} = require('./src/services/stagePlanService');
const { buildLongTermContext } = require('./src/services/longTermContextService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function planInput(calculationId) {
  return {
    stageLabel: '第一阶段',
    objective: '先建立规律饮食结构',
    durationDays: 14,
    energyCalculationId: calculationId,
    mealGuidance: [{ mealType: 'general', guidance: '主食、蛋白质和蔬菜合理搭配。' }],
    adjustmentRules: ['根据真实反馈调整'],
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-context-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:77777777-7777-4777-8777-777777777777';

  store.updateProfile(userId, {
    body: { ageYears: 22, heightCm: 165, currentWeightKg: 60 },
    diet: { scene: 'cafeteria', tastePreferences: ['酸甜'] },
    menstrualTracking: { applicability: 'applicable', status: 'active' },
  }, { now: '2026-08-05T08:00:00+08:00' });
  store.appendEvent({
    userId,
    eventType: 'meal',
    occurredAt: '2026-08-05T12:00:00+08:00',
    payload: { summary: '午餐吃了米饭和鸡腿', rawText: '我中午吃了米饭鸡腿' },
  });

  const freeContext = await buildLongTermContext(userId, {
    store,
    now: '2026-08-05T20:00:00+08:00',
  });
  assert(freeContext.accessMode === 'basic_profile_only', '免费用户上下文权限错误');
  assert(freeContext.recentEvents.length === 0, '免费用户读取了长期事件');
  assert(freeContext.activePlan === null && freeContext.latestEnergyCalculation === null, '免费用户读取了计划或计算历史');
  assert(freeContext.profile.profile.menstrualTracking.status === 'unknown', '未授权时暴露经期档案状态');

  await selectLongTermService(userId, { store, now: '2026-08-05T20:10:00+08:00' });
  await confirmLongTermProfile(userId, { store, now: '2026-08-05T20:20:00+08:00' });
  const calculation = await calculateAndRecordAdultEnergy(userId, {
    equationSex: 'female', ageYears: 22, heightCm: 165, weightKg: 60, activityLevel: 'light',
  }, { store, now: '2026-08-05T20:25:00+08:00' });
  const plan = await createStagePlanDraft(userId, planInput(calculation.calculationId), {
    store,
    now: '2026-08-05T20:30:00+08:00',
  });
  await markOfficialPlanDelivered(userId, plan.planId, {
    store,
    deliveredAt: '2026-08-05T20:35:00+08:00',
  });
  store.appendEvent({
    userId,
    eventType: 'exercise',
    occurredAt: '2026-08-06T18:00:00+08:00',
    payload: { summary: '跑步30分钟', rawText: '我跑了30分钟' },
  });
  store.appendEvent({
    userId,
    eventType: 'check_in',
    occurredAt: '2026-08-06T19:00:00+08:00',
    payload: { summary: '晚餐后饱腹感合适', rawText: '今天晚餐吃完刚好' },
  });
  store.appendEvent({
    userId,
    eventType: 'menstrual_period_start',
    occurredAt: '2026-08-04T08:00:00+08:00',
    payload: { summary: '月经开始', rawText: '8月4号来的' },
  });

  await recordUserConsent(userId, {
    consentType: 'menstrual_tracking', status: 'granted',
    recordedAt: '2026-08-05T20:36:00+08:00', source: 'user',
  }, { store });
  const activeContext = await buildLongTermContext(userId, {
    store,
    now: '2026-08-06T20:00:00+08:00',
  });
  assert(activeContext.accessMode === 'long_term', '体验用户没有长期上下文权限');
  assert(activeContext.activePlan.planId === plan.planId, '没有读取当前生效计划');
  assert(activeContext.latestEnergyCalculation.calculationId === calculation.calculationId, '没有读取最新计算记录');
  assert(activeContext.recentEvents.some((event) => event.eventType === 'exercise'), '没有读取近期普通事件');
  assert(activeContext.recentEvents.some((event) => event.eventType === 'menstrual_period_start'), '授权后没有读取经期事件');
  assert(
    activeContext.recentEvents.every((event, index, events) =>
      index === 0 || new Date(events[index - 1].occurredAt).getTime() >= new Date(event.occurredAt).getTime()),
    '近期事件没有按occurredAt稳定倒序排列'
  );
  assert(activeContext.recentEvents[0].eventType === 'check_in', '最新发生的事件没有排在第一位');
  assert(activeContext.recentEvents.every((event) => !Object.hasOwn(event.payload, 'rawText')), '上下文泄露了不必要的用户原话');

  await pausePlanForInterruption(userId, '连续出差三天', {
    store, now: '2026-08-06T20:00:30+08:00',
  });
  const pausedContext = await buildLongTermContext(userId, {
    store, now: '2026-08-06T20:00:40+08:00',
  });
  assert(pausedContext.activePlan === null, '暂停计划仍被当作活动计划提供');
  assert(pausedContext.pausedPlan?.planId === plan.planId, '下一轮上下文没有提供最近暂停计划');
  await resumeSamePlan(userId, plan.planId, {
    store, userConfirmed: true, now: '2026-08-06T20:00:50+08:00',
  });
  const resumedContext = await buildLongTermContext(userId, {
    store, now: '2026-08-06T20:01:00+08:00',
  });
  assert(resumedContext.activePlan?.planId === plan.planId, '确认恢复后上下文没有重新提供活动计划');
  assert(resumedContext.pausedPlan === null, '确认恢复后仍残留暂停计划');

  await recordUserConsent(userId, {
    consentType: 'menstrual_tracking', status: 'revoked',
    recordedAt: '2026-08-06T20:01:10+08:00', source: 'user',
  }, { store });
  const revokedContext = await buildLongTermContext(userId, {
    store, now: '2026-08-06T20:02:00+08:00',
  });
  assert(!revokedContext.recentEvents.some((event) => event.eventType.startsWith('menstrual_')), '撤回授权后仍读取经期历史');
  assert(revokedContext.profile.profile.menstrualTracking.status === 'unknown', '撤回授权后仍暴露经期档案状态');

  await expireTrialIfDue(userId, { store, now: '2026-08-19T12:35:01.000Z' });
  const expiredContext = await buildLongTermContext(userId, {
    store,
    now: '2026-08-19T12:36:00.000Z',
  });
  assert(expiredContext.accessMode === 'basic_profile_only', '体验到期后仍有长期上下文权限');
  assert(expiredContext.recentEvents.length === 0 && expiredContext.activePlan === null, '体验到期后仍读取长期记录或计划');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 免费和到期用户只能读取基础档案');
  console.log('✅ 体验中用户可读取当前计划、最新计算和限定时间内事件');
  console.log('✅ 经期授权撤回后历史敏感记录立即从上下文消失');
  console.log('✅ 提供给秘书的事件上下文移除不必要的用户原话');
  console.log('✅ 近期事件在上下文层按occurredAt稳定倒序排列');
  console.log('✅ 暂停计划与活动计划在上下文中严格区分，确认恢复后才重新激活');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
