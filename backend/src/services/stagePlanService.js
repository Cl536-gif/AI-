const { z } = require('zod');
const userService = require('./userService');
const {
  canRecordLongTermEvents,
  TRIAL_DURATION_MS,
  RENEWAL_REMINDER_DELAY_MS,
} = require('./longTermService');
const { UserIdSchema } = require('../domain/userDataContract');

const StagePlanSchema = z.object({
  stageLabel: z.string().min(1).max(100),
  objective: z.string().min(1).max(500),
  durationDays: z.number().int().min(1).max(90),
  energyCalculationId: z.string().min(1).max(128),
  mealGuidance: z.array(z.object({
    mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'general']),
    guidance: z.string().min(1).max(2000),
  })).min(1).max(20),
  adjustmentRules: z.array(z.string().min(1).max(500)).max(30).default([]),
}).strict();

async function requirePlanEligibleStatus(userId, store) {
  const status = (await userService.getServiceStatus(userId, { store }))?.status || 'free';
  if (!['profile_confirmed', 'trial_active', 'subscribed'].includes(status)) {
    throw new Error(`当前${status}状态不能建立长期阶段计划`);
  }
  return status;
}

async function createStagePlanDraft(userId, planInput, {
  store,
  parentPlanId = null,
  changeReason = 'initial_stage_plan',
  now = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  await requirePlanEligibleStatus(normalizedUserId, store);
  const plan = StagePlanSchema.parse(planInput);
  return await userService.createPlanDraft(normalizedUserId, {
    calculationId: plan.energyCalculationId,
    parentPlanId,
    plan,
    changeReason,
  }, { store, now });
}

async function markOfficialPlanDelivered(userId, planId, {
  store,
  deliveredAt = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const plan = await userService.getPlan(normalizedUserId, planId, { store });
  if (!plan) throw new Error('正式计划不存在或不属于当前用户');
  if (plan.status === 'active') return plan;
  if (plan.status !== 'draft' && plan.status !== 'paused') throw new Error('只有草稿或暂停计划可以启用');
  const serviceStatus = (await userService.getServiceStatus(normalizedUserId, { store }))?.status || 'free';
  if (serviceStatus === 'profile_confirmed') {
    const start = new Date(deliveredAt);
    if (Number.isNaN(start.getTime())) throw new Error('正式方案交付时间格式不正确');
    return await userService.activateInitialPlanAndTrial(normalizedUserId, planId, {
      trialStartedAt: start.toISOString(),
      trialEndsAt: new Date(start.getTime() + TRIAL_DURATION_MS).toISOString(),
      renewalReminderAt: new Date(start.getTime() + RENEWAL_REMINDER_DELAY_MS).toISOString(),
    }, { store });
  } else if (!await canRecordLongTermEvents(normalizedUserId, { store, now: deliveredAt })) {
    throw new Error(`当前${serviceStatus}状态不能启用长期计划`);
  }
  return await userService.transitionPlan(normalizedUserId, planId, 'active', {
    store,
    reason: 'official_plan_delivered',
    now: deliveredAt,
  });
}

async function pausePlanForInterruption(userId, reason, {
  store,
  now = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('暂停计划必须记录原因');
  const active = await userService.getActivePlan(normalizedUserId, { store });
  if (!active) throw new Error('当前没有正在执行的计划');
  return await userService.transitionPlan(normalizedUserId, active.planId, 'paused', {
    store,
    reason: `plan_interruption:${reason.trim()}`,
    now,
  });
}

async function resumeSamePlan(userId, planId, {
  store,
  userConfirmed = false,
  now = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  if (!userConfirmed) throw new Error('恢复原计划前必须由用户确认');
  if (!await canRecordLongTermEvents(normalizedUserId, { store, now })) {
    throw new Error('当前服务状态不能恢复长期计划');
  }
  return await userService.transitionPlan(normalizedUserId, planId, 'active', {
    store,
    reason: 'user_confirmed_resume_same_plan',
    now,
  });
}

module.exports = {
  StagePlanSchema,
  createStagePlanDraft,
  markOfficialPlanDelivered,
  pausePlanForInterruption,
  resumeSamePlan,
};
