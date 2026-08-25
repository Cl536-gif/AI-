const { UserIdSchema } = require('../domain/userDataContract');
const userService = require('./userService');

const SERVICE_STATUSES = [
  'free',
  'onboarding_incomplete',
  'profile_confirmed',
  'trial_active',
  'trial_expired',
  'subscribed',
  'cancelled',
];
const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const RENEWAL_REMINDER_DELAY_MS = 13 * 24 * 60 * 60 * 1000;

function parseNow(now) {
  const date = new Date(now || new Date().toISOString());
  if (Number.isNaN(date.getTime())) throw new Error('服务状态时间格式不正确');
  return date;
}

function requireStatus(current, allowed, actionLabel) {
  const status = current?.status || 'free';
  if (!allowed.includes(status)) {
    throw new Error(`${actionLabel}不允许从${status}状态执行`);
  }
}

async function selectLongTermService(userId, { store, now = new Date().toISOString() } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const current = await userService.getServiceStatus(normalizedUserId, { store });
  requireStatus(current, ['free', 'trial_expired', 'cancelled'], '选择长期方案');
  return await userService.setServiceStatus(normalizedUserId, {
    status: 'onboarding_incomplete',
  }, { store, reason: 'long_term_selected', now });
}

async function confirmLongTermProfile(userId, { store, now = new Date().toISOString() } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const current = await userService.getServiceStatus(normalizedUserId, { store });
  requireStatus(current, ['onboarding_incomplete'], '确认长期档案');
  return await userService.setServiceStatus(normalizedUserId, {
    status: 'profile_confirmed',
  }, { store, reason: 'profile_confirmed_by_user', now });
}

async function activateTrialAfterOfficialPlan(userId, officialPlanId, {
  store,
  now = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  if (typeof officialPlanId !== 'string' || !officialPlanId.trim()) {
    throw new Error('正式长期方案ID不能为空');
  }
  const current = await userService.getServiceStatus(normalizedUserId, { store });
  requireStatus(current, ['profile_confirmed'], '启动14天体验');
  const start = parseNow(now);
  return await userService.setServiceStatus(normalizedUserId, {
    status: 'trial_active',
    trialStartedAt: start.toISOString(),
    trialEndsAt: new Date(start.getTime() + TRIAL_DURATION_MS).toISOString(),
    renewalReminderAt: new Date(start.getTime() + RENEWAL_REMINDER_DELAY_MS).toISOString(),
    officialPlanId: officialPlanId.trim(),
  }, { store, reason: 'first_official_plan_delivered', now: start.toISOString() });
}

async function expireTrialIfDue(userId, { store, now = new Date().toISOString() } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const current = await userService.getServiceStatus(normalizedUserId, { store });
  if (!current || current.status !== 'trial_active') return current;
  const currentTime = parseNow(now);
  if (currentTime < new Date(current.trialEndsAt)) return current;
  return await userService.setServiceStatus(normalizedUserId, {
    ...current,
    status: 'trial_expired',
  }, { store, reason: 'trial_period_ended_without_subscription', now: currentTime.toISOString() });
}

async function confirmSubscription(userId, paymentReference, {
  store,
  now = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  if (typeof paymentReference !== 'string' || !paymentReference.trim()) {
    throw new Error('没有明确支付确认，不能开通正式订阅');
  }
  const current = await userService.getServiceStatus(normalizedUserId, { store });
  requireStatus(current, ['trial_active', 'trial_expired'], '开通正式订阅');
  return await userService.setServiceStatus(normalizedUserId, {
    ...current,
    status: 'subscribed',
  }, { store, reason: `payment_confirmed:${paymentReference.trim()}`, now });
}

async function canRecordLongTermEvents(userId, { store, now = new Date().toISOString() } = {}) {
  const current = await expireTrialIfDue(userId, { store, now });
  return Boolean(current && ['trial_active', 'subscribed'].includes(current.status));
}

module.exports = {
  SERVICE_STATUSES,
  TRIAL_DURATION_MS,
  RENEWAL_REMINDER_DELAY_MS,
  selectLongTermService,
  confirmLongTermProfile,
  activateTrialAfterOfficialPlan,
  expireTrialIfDue,
  confirmSubscription,
  canRecordLongTermEvents,
};
