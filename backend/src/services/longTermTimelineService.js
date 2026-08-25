const { UserIdSchema } = require('../domain/userDataContract');
const userService = require('./userService');

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DAY_MS = 24 * 60 * 60 * 1000;

function localDateKey(value, timezone = DEFAULT_TIMEZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('时间格式不正确');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateOrdinal(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function calendarDayDifference(start, end, timezone = DEFAULT_TIMEZONE) {
  return dateOrdinal(localDateKey(end, timezone)) - dateOrdinal(localDateKey(start, timezone));
}

function startOfCurrentReviewWindow(planStartedAt, now, planDay, timezone) {
  if (planDay === 2) return 1;
  const completedWeeks = Math.floor((planDay - 1) / 7);
  return completedWeeks * 7;
}

function classifyWeightTrend(weightMeasurements) {
  if (weightMeasurements.length < 3) return { status: 'insufficient_data', spanDays: 0, changeKg: null };
  const newest = weightMeasurements[0];
  const oldest = weightMeasurements[weightMeasurements.length - 1];
  const spanDays = Math.max(0, calendarDayDifference(oldest.occurredAt, newest.occurredAt));
  const changeKg = Number((newest.weightKg - oldest.weightKg).toFixed(2));
  const changePercent = Number(((changeKg / oldest.weightKg) * 100).toFixed(2));
  // 这是保守的产品候选规则，不是医学诊断：至少观察21天，且标准化体重
  // 总变化不足0.5%，才允许进入“可能平台期”的进一步核查。
  const possiblePlateau = spanDays >= 21 && Math.abs(changePercent) < 0.5;
  return {
    status: possiblePlateau ? 'possible_plateau' : 'trend_available',
    spanDays,
    changeKg,
    changePercent,
  };
}

async function buildLongTermTimeline(userId, {
  store,
  now = new Date().toISOString(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const service = await userService.getServiceStatus(normalizedUserId, { store });
  const hasLongTermAccess = ['trial_active', 'subscribed'].includes(service?.status);
  if (!hasLongTermAccess || !service?.trialStartedAt) {
    return {
      planStartedAt: null,
      planDay: null,
      recordedDayCount: 0,
      consecutiveRecordedDays: 0,
      lastRecordedAt: null,
      dueCheckIn: null,
      nextWeeklyReviewDay: null,
      weightMeasurements: [],
      weightTrend: { status: 'insufficient_data', spanDays: 0, changeKg: null },
    };
  }

  const planStartedAt = service.trialStartedAt;
  const planDay = Math.max(1, calendarDayDifference(planStartedAt, now, timezone) + 1);
  const events = (await userService.listEvents(normalizedUserId, { limit: 500 }, { store }))
    .filter((event) => new Date(event.occurredAt) >= new Date(planStartedAt));
  const recordedDateKeys = [...new Set(events.map((event) => localDateKey(event.occurredAt, timezone)))]
    .sort();
  let consecutiveRecordedDays = 0;
  for (let index = recordedDateKeys.length - 1; index >= 0; index -= 1) {
    if (index === recordedDateKeys.length - 1 ||
        dateOrdinal(recordedDateKeys[index + 1]) - dateOrdinal(recordedDateKeys[index]) === 1) {
      consecutiveRecordedDays += 1;
    } else {
      break;
    }
  }

  const checkIns = events.filter((event) => event.eventType === 'check_in');
  const reviewWindowStartOffset = startOfCurrentReviewWindow(planStartedAt, now, planDay, timezone);
  const hasCurrentWindowCheckIn = checkIns.some((event) =>
    calendarDayDifference(planStartedAt, event.occurredAt, timezone) >= reviewWindowStartOffset
  );
  let dueCheckIn = null;
  if (planDay === 2 && !hasCurrentWindowCheckIn) {
    dueCheckIn = 'day_2_meal_feedback';
  } else if (planDay >= 8 && (planDay - 1) % 7 === 0 && !hasCurrentWindowCheckIn) {
    dueCheckIn = 'weekly_review';
  }

  const weightMeasurements = events
    // body_measurement.payload.weightKg 是每次测量的时间点值；档案里的
    // bodyProfile.currentWeightKg 不属于事件载荷，不能在这里混用。
    .filter((event) => event.eventType === 'body_measurement' &&
      Number.isFinite(Number(event.payload?.weightKg)))
    .map((event) => ({
      occurredAt: event.occurredAt,
      weightKg: Number(event.payload.weightKg),
    }))
    .sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt));

  const weightTrend = classifyWeightTrend(weightMeasurements);
  return {
    planStartedAt,
    planDay,
    recordedDayCount: recordedDateKeys.length,
    consecutiveRecordedDays,
    lastRecordedAt: events[0]?.occurredAt || null,
    dueCheckIn,
    nextWeeklyReviewDay: (Math.floor((planDay - 1) / 7) + 1) * 7 + 1,
    weightMeasurements: weightMeasurements.slice(0, 12),
    weightTrend,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  localDateKey,
  calendarDayDifference,
  classifyWeightTrend,
  buildLongTermTimeline,
};
