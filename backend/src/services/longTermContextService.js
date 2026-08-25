const { expireTrialIfDue } = require('./longTermService');
const { UserIdSchema } = require('../domain/userDataContract');
const { buildLongTermTimeline } = require('./longTermTimelineService');
const { DEFAULT_TIMEZONE, formatTemporalContext } = require('./userTimeService');
const userService = require('./userService');

const SENSITIVE_EVENT_TYPES = new Set(['menstrual_period_start', 'menstrual_symptom']);
const LONG_TERM_STATUSES = new Set(['trial_active', 'subscribed']);
const DEFAULT_EVENT_LOOKBACK_DAYS = 14;
const DEFAULT_EVENT_LIMIT = 50;

function sanitizeEvent(event) {
  const payload = { ...event.payload };
  delete payload.rawText;
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    payload,
  };
}

function profileForContext(profileRecord, menstrualConsentGranted) {
  if (!profileRecord) return null;
  const profile = structuredClone(profileRecord.profile);
  if (!menstrualConsentGranted) {
    profile.menstrualTracking = { applicability: 'unknown', status: 'unknown' };
  }
  return {
    profileVersion: profileRecord.profileVersion,
    profile,
    updatedAt: profileRecord.updatedAt,
  };
}

async function buildLongTermContext(userId, {
  store,
  now = new Date().toISOString(),
  eventLookbackDays = DEFAULT_EVENT_LOOKBACK_DAYS,
  eventLimit = DEFAULT_EVENT_LIMIT,
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const userSettings = await userService.getUserSettings(normalizedUserId, { store });
  const timezone = userSettings?.timezone || DEFAULT_TIMEZONE;
  const currentService = await expireTrialIfDue(normalizedUserId, { store, now });
  const serviceStatus = currentService?.status || 'free';
  const hasLongTermAccess = LONG_TERM_STATUSES.has(serviceStatus);
  const menstrualConsent = await userService.getLatestConsent(normalizedUserId, 'menstrual_tracking', { store });
  const menstrualConsentGranted = menstrualConsent?.status === 'granted';
  const profile = profileForContext(await userService.getProfile(normalizedUserId, { store }), menstrualConsentGranted);

  const context = {
    userId: normalizedUserId,
    generatedAt: new Date(now).toISOString(),
    temporalContext: formatTemporalContext(now, timezone),
    accessMode: hasLongTermAccess ? 'long_term' : 'basic_profile_only',
    serviceStatus,
    profile,
    activePlan: null,
    pausedPlan: null,
    latestEnergyCalculation: null,
    recentAdvice: await userService.listAdviceHistory(normalizedUserId, { limit: 10 }, { store }),
    recentEvents: [],
    permissions: {
      longTermEvents: hasLongTermAccess,
      menstrualHistory: hasLongTermAccess && menstrualConsentGranted,
    },
    timeline: null,
  };

  if (!hasLongTermAccess) return context;

  context.timeline = await buildLongTermTimeline(normalizedUserId, { store, now, timezone });

  context.activePlan = await userService.getActivePlan(normalizedUserId, { store });
  context.pausedPlan = (await userService.listPlans(normalizedUserId, { limit: 50 }, { store }))
    .filter((plan) => plan.status === 'paused')
    .sort((left, right) => {
      const timeDifference = new Date(right.pausedAt || right.createdAt).getTime() -
        new Date(left.pausedAt || left.createdAt).getTime();
      if (timeDifference !== 0) return timeDifference;
      return right.planVersion - left.planVersion;
    })[0] || null;
  context.latestEnergyCalculation = (await userService.listEnergyCalculations(
    normalizedUserId, { limit: 1 }, { store }
  ))[0] || null;

  const lookbackMs = Math.max(1, Math.min(Number(eventLookbackDays) || DEFAULT_EVENT_LOOKBACK_DAYS, 90)) *
    24 * 60 * 60 * 1000;
  const cutoff = new Date(now).getTime() - lookbackMs;
  const safeLimit = Math.max(1, Math.min(Number(eventLimit) || DEFAULT_EVENT_LIMIT, 100));
  context.recentEvents = (await userService.listEvents(normalizedUserId, { limit: 500 }, { store }))
    .filter((event) => new Date(event.occurredAt).getTime() >= cutoff)
    .filter((event) => menstrualConsentGranted || !SENSITIVE_EVENT_TYPES.has(event.eventType))
    .sort((left, right) => {
      const timeDifference = new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
      if (timeDifference !== 0) return timeDifference;
      return right.eventId.localeCompare(left.eventId);
    })
    .slice(0, safeLimit)
    .map(sanitizeEvent);

  return context;
}

module.exports = {
  SENSITIVE_EVENT_TYPES,
  LONG_TERM_STATUSES,
  DEFAULT_EVENT_LOOKBACK_DAYS,
  DEFAULT_EVENT_LIMIT,
  sanitizeEvent,
  buildLongTermContext,
};
