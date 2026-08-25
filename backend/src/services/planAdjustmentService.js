const { pausePlanForInterruption } = require('./stagePlanService');
const { resumeSamePlan } = require('./stagePlanService');
const { UserIdSchema } = require('../domain/userDataContract');
const userService = require('./userService');

async function processPlanLifecycleFromEvents(userId, eventPersistence, {
  store,
  now = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  if (eventPersistence?.status !== 'recorded') {
    return { status: 'not_evaluated', action: 'none', reason: eventPersistence?.status || 'no_event_result' };
  }

  const events = eventPersistence.recordedEvents || [];
  const interruption = events.find((event) => event.eventType === 'plan_interruption');
  if (!interruption) {
    return {
      status: 'evaluated',
      action: events.length ? 'observe_only' : 'none',
      reason: events.length ? 'ordinary_events_do_not_rewrite_plan' : 'no_events',
    };
  }

  const activePlan = await userService.getActivePlan(normalizedUserId, { store });
  if (!activePlan) {
    return { status: 'evaluated', action: 'none', reason: 'no_active_plan' };
  }

  const reason = interruption.payload?.reason || interruption.payload?.summary || '用户报告计划中断';
  const pausedPlan = await pausePlanForInterruption(normalizedUserId, reason, { store, now });
  return {
    status: 'evaluated',
    action: 'plan_paused',
    reason,
    planId: pausedPlan.planId,
    planVersion: pausedPlan.planVersion,
  };
}

const RESUME_PLAN_REGEX = /(?:继续|恢复|接着)(?:执行|使用|按照|按)?(?:原来|原先|原本|之前|上次|这个)?(?:的)?(?:计划|方案)|按(?:原来|原先|原本|之前|上次)(?:的)?(?:计划|方案)?继续/;
const NEW_PLAN_REGEX = /(?:重新|重做|新做|换一(?:个|套)|制定新|做新)(?:调整|制定|安排)?(?:的)?(?:计划|方案)|(?:按|根据)(?:现在|目前|新的|当前).{0,10}(?:重新|重做|调整)(?:计划|方案)?/;

async function findLatestPausedPlan(userId, store) {
  return (await userService.listPlans(userId, { limit: 50 }, { store }))
    .filter((plan) => plan.status === 'paused')
    .sort((left, right) => {
      const timeDifference = new Date(right.pausedAt || right.createdAt).getTime() -
        new Date(left.pausedAt || left.createdAt).getTime();
      if (timeDifference !== 0) return timeDifference;
      return right.planVersion - left.planVersion;
    })[0] || null;
}

async function processPlanRecoveryChoice(userId, message, {
  store,
  now = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const pausedPlan = await findLatestPausedPlan(normalizedUserId, store);
  if (!pausedPlan) return { status: 'not_applicable', action: 'none', reason: 'no_paused_plan' };

  const text = String(message || '').replace(/\s+/g, '').trim();
  const wantsResume = RESUME_PLAN_REGEX.test(text);
  const wantsNewPlan = NEW_PLAN_REGEX.test(text);
  if (wantsResume && wantsNewPlan) {
    return { status: 'needs_clarification', action: 'none', reason: 'conflicting_recovery_choice' };
  }
  if (wantsResume) {
    const resumed = await resumeSamePlan(normalizedUserId, pausedPlan.planId, {
      store, userConfirmed: true, now,
    });
    return {
      status: 'resolved', action: 'plan_resumed', reason: 'explicit_user_choice',
      planId: resumed.planId, planVersion: resumed.planVersion,
    };
  }
  if (wantsNewPlan) {
    return {
      status: 'resolved', action: 'new_version_requested', reason: 'explicit_user_choice',
      parentPlanId: pausedPlan.planId, parentPlanVersion: pausedPlan.planVersion,
    };
  }
  return { status: 'awaiting_choice', action: 'none', reason: 'no_explicit_recovery_choice' };
}

module.exports = {
  RESUME_PLAN_REGEX,
  NEW_PLAN_REGEX,
  findLatestPausedPlan,
  processPlanLifecycleFromEvents,
  processPlanRecoveryChoice,
};
