const DEFAULT_TIMEZONE = 'Asia/Shanghai';

const TIMEZONE_MENTIONS = [
  { pattern: /(?:北京|中国大陆|国内)(?:时间|时区)?/u, timezone: 'Asia/Shanghai' },
  { pattern: /(?:纽约|美东)(?:时间|时区)?/u, timezone: 'America/New_York' },
  { pattern: /(?:洛杉矶|美西)(?:时间|时区)?/u, timezone: 'America/Los_Angeles' },
  { pattern: /(?:伦敦|英国)(?:时间|时区)?/u, timezone: 'Europe/London' },
  { pattern: /(?:东京|日本)(?:时间|时区)?/u, timezone: 'Asia/Tokyo' },
  { pattern: /(?:首尔|韩国)(?:时间|时区)?/u, timezone: 'Asia/Seoul' },
  { pattern: /(?:新加坡)(?:时间|时区)?/u, timezone: 'Asia/Singapore' },
  { pattern: /(?:悉尼)(?:时间|时区)?/u, timezone: 'Australia/Sydney' },
];

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(new Date());
    return true;
  } catch (_err) {
    return false;
  }
}

function detectExplicitTimezone(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  const iana = text.match(/\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?\b/);
  if (iana && isValidTimezone(iana[0])) return iana[0];

  // 只有用户明确表达“当前在/去了/时区改为”等位置或时区语义时才更新，
  // 避免普通聊天里提到“想吃纽约披萨”就误改时区。
  if (!/(?:我(?:现在|目前)?在|我(?:到|去|去了|来到)|时区|当地时间|按.+时间)/u.test(text)) return null;
  return TIMEZONE_MENTIONS.find((item) => item.pattern.test(text))?.timezone || null;
}

function formatTemporalContext(now = new Date().toISOString(), timezone = DEFAULT_TIMEZONE) {
  const safeTimezone = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error('当前时间格式不正确');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: safeTimezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const minuteOfDay = hour * 60 + minute;
  let mealTiming;
  if (minuteOfDay >= 5 * 60 && minuteOfDay < 10 * 60 + 30) {
    mealTiming = { currentWindow: 'breakfast', currentWindowLabel: '早餐时段', suggestedMeal: 'breakfast', suggestedMealLabel: '早餐' };
  } else if (minuteOfDay < 11 * 60 + 30) {
    mealTiming = { currentWindow: 'between_breakfast_and_lunch', currentWindowLabel: '早餐与午餐之间', suggestedMeal: 'lunch', suggestedMealLabel: '午餐' };
  } else if (minuteOfDay < 14 * 60) {
    mealTiming = { currentWindow: 'lunch', currentWindowLabel: '午餐时段', suggestedMeal: 'lunch', suggestedMealLabel: '午餐' };
  } else if (minuteOfDay < 17 * 60) {
    mealTiming = { currentWindow: 'between_lunch_and_dinner', currentWindowLabel: '午餐与晚餐之间', suggestedMeal: 'dinner', suggestedMealLabel: '晚餐' };
  } else if (minuteOfDay < 21 * 60 + 30) {
    mealTiming = { currentWindow: 'dinner', currentWindowLabel: '晚餐时段', suggestedMeal: 'dinner', suggestedMealLabel: '晚餐' };
  } else {
    mealTiming = { currentWindow: 'late_evening', currentWindowLabel: '晚间时段', suggestedMeal: 'snack', suggestedMealLabel: '按需加餐' };
  }
  return {
    timezone: safeTimezone,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    mealTiming,
    generatedAt: date.toISOString(),
  };
}

function detectExplicitMealTarget(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  if (/(?:早餐|早饭|早上吃什么|明早吃什么)/u.test(text)) return { meal: 'breakfast', label: '早餐' };
  if (/(?:午餐|中饭|中午吃什么)/u.test(text)) return { meal: 'lunch', label: '午餐' };
  if (/(?:晚餐|晚饭|今晚吃什么|今晚怎么吃)/u.test(text)) return { meal: 'dinner', label: '晚餐' };
  if (/(?:夜宵|加餐吃什么|吃什么加餐)/u.test(text)) return { meal: 'snack', label: '加餐' };
  return null;
}

module.exports = {
  DEFAULT_TIMEZONE,
  TIMEZONE_MENTIONS,
  isValidTimezone,
  detectExplicitTimezone,
  detectExplicitMealTarget,
  formatTemporalContext,
};
