const NUMBER_TOKEN = String.raw`(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百半]+)`;
const WEIGHT_LOSS_WORD_REGEX = /(减重|减肥|瘦|减掉|掉秤)/u;
const EXPLICIT_LOSS_INTENT_REGEX =
  /(?:帮我|我想|想要|想|希望|目标|计划|打算|争取|保证|确保|能不能|可以)[^。！？\n]{0,28}(?:减重|减肥|瘦|减掉|掉秤)/u;
const PAST_LOSS_REGEX = /(?:已经|过去|上周|上个月|最近)[^。！？\n]{0,16}(?:瘦了|减了|掉了)/u;
const PROMISE_PRESSURE_REGEX =
  /(?:保证|确保|包)[^。！？\n]{0,24}(?:瘦|减重|减肥|减掉)|(?:瘦|减重|减肥|减掉)[^。！？\n]{0,24}(?:保证|确保|一定|肯定)/u;
const TIME_EXPECTATION_REGEX = /(大概|预计|估计)?(?:多久|多长时间|几周|几个月|什么时候)(?:能|可以|会)?(?:瘦|减|到)?/u;

function parseChineseNumber(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === '半') return 0.5;

  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.includes('百')) {
    const [hundreds, rest = ''] = value.split('百');
    const base = (digits[hundreds] || 1) * 100;
    return base + (parseChineseNumber(rest) || 0);
  }
  if (value.includes('十')) {
    const [tens, ones = ''] = value.split('十');
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  if (value.length === 1 && digits[value] !== undefined) return digits[value];
  return null;
}

function toKilograms(value, unit) {
  if (!Number.isFinite(value)) return null;
  return unit === '斤' ? value / 2 : value;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function parseRequestedLossRate(userText, { assumeGoalIntent = false } = {}) {
  const text = String(userText || '').replace(/\s+/g, '');
  if (!text || PAST_LOSS_REGEX.test(text)) return null;
  if (!assumeGoalIntent && !EXPLICIT_LOSS_INTENT_REGEX.test(text)) return null;

  const durationMatch = text.match(new RegExp(`(${NUMBER_TOKEN})(?:个)?(天|周|星期|个月|月)`, 'u'));
  const lossMatch = text.match(new RegExp(`(?:瘦|减掉|减重|减肥|掉秤)(?:到)?(${NUMBER_TOKEN})(斤|公斤|千克|kg)`, 'iu'));
  if (!durationMatch || !lossMatch) return null;

  const durationValue = parseChineseNumber(durationMatch[1]);
  const lossValue = parseChineseNumber(lossMatch[1]);
  if (!durationValue || !lossValue) return null;

  const durationUnit = durationMatch[2];
  const weeks = durationUnit === '天'
    ? durationValue / 7
    : (durationUnit === '周' || durationUnit === '星期' ? durationValue : durationValue * 4);
  const lossKg = toKilograms(lossValue, lossMatch[2]);
  if (!weeks || !lossKg) return null;

  return {
    weeks,
    lossKg,
    kgPerWeek: lossKg / weeks,
    durationText: durationMatch[0],
    lossText: lossMatch[0].replace(/^(?:瘦|减掉|减重|减肥|掉秤)/u, ''),
  };
}

function parseWeightReference(userText, bodyProfile = {}) {
  const text = String(userText || '').replace(/\s+/g, '');
  if (!TIME_EXPECTATION_REGEX.test(text)) return null;

  const currentMatch = text.match(new RegExp(`(?:我)?(?:现在|目前|当前)(${NUMBER_TOKEN})(斤|公斤|千克|kg)`, 'iu'));
  const targetMatch = text.match(new RegExp(`(?:想|希望|目标(?:体重)?(?:是|为)?|计划)?(?:减到|瘦到)(${NUMBER_TOKEN})(斤|公斤|千克|kg)`, 'iu'));
  const currentKg = currentMatch
    ? toKilograms(parseChineseNumber(currentMatch[1]), currentMatch[2])
    : Number(bodyProfile.currentWeightKg);
  const targetKg = targetMatch
    ? toKilograms(parseChineseNumber(targetMatch[1]), targetMatch[2])
    : Number(bodyProfile.targetWeightKg);
  if (!Number.isFinite(currentKg) || !Number.isFinite(targetKg) || currentKg <= targetKg) return null;

  const differenceKg = currentKg - targetKg;
  return {
    currentKg,
    targetKg,
    differenceKg,
    minimumWeeks: Math.ceil(differenceKg / 1),
    maximumWeeks: Math.ceil(differenceKg / 0.5),
  };
}

function calculateBmi(bodyProfile = {}) {
  const heightCm = Number(bodyProfile.heightCm);
  const weightKg = Number(bodyProfile.currentWeightKg);
  if (!Number.isFinite(heightCm) || !Number.isFinite(weightKg) || heightCm <= 0 || weightKg <= 0) return null;
  return weightKg / ((heightCm / 100) ** 2);
}

function buildSpeedRedlineResponse(rate, hasProfile) {
  return (
    '想快点看到变化，这个心情我理解。健康减重通常以每周约0.5～1公斤作为平均参照；' +
    `你提出的“${rate.durationText}${rate.lossText}”约等于每周${formatNumber(rate.kgPerWeek)}公斤，超过这个范围，` +
    '我不能保证，也不会按这个速度给你生成方案。按健康速度同样可以逐步接近目标，前两周体重掉得快时常包含水分变化，之后要看真实趋势。' +
    '我能保证的是方案不踩你已经声明的忌口、记录不丢，并且每周根据真实记录复盘调整；' +
    (hasProfile ? '' : '目前还没有完整档案的部分，我不会自行假设。')
  );
}

function buildBmiFloorResponse(bodyProfile, bmi) {
  return (
    `按你已记录的身高${formatNumber(Number(bodyProfile.heightCm))}厘米和当前体重${formatNumber(Number(bodyProfile.currentWeightKg))}公斤，` +
    `BMI约为${formatNumber(bmi)}，已经低于18.5。想继续变轻的心情我理解，但我不能配合继续减重，也不会生成减重方案；` +
    '接下来应以维持健康、恢复稳定饮食为主，如果仍担心体型或体重，建议先和医生或注册营养师确认。'
  );
}

function buildScientificReferenceResponse(reference) {
  const minMonths = reference.minimumWeeks / 4;
  const maxMonths = reference.maximumWeeks / 4;
  return (
    `从${formatNumber(reference.currentKg)}公斤到${formatNumber(reference.targetKg)}公斤，目标差${formatNumber(reference.differenceKg)}公斤。` +
    `按每周约0.5～1公斤的健康减重速度，平均参照约${reference.minimumWeeks}～${reference.maximumWeeks}周，` +
    `也就是约${formatNumber(minMonths)}～${formatNumber(maxMonths)}个月。` +
    '这是平均参照，不是对你的承诺；前两周下降较快时常包含水分变化，中间也可能有平台期。' +
    '我们每两周复盘一次，用你的真实体重记录校准这个估算。'
  );
}

function buildPromisePressureResponse(hasProfile) {
  return (
    '我不能保证你在某个具体时间一定瘦到某个数字，因为个体变化、水分波动和执行情况都会影响结果。' +
    '我能做的是按每周约0.5～1公斤的健康速度给你可执行方向，同时保证方案不踩你已经声明的忌口、记录不丢，并且每周根据真实记录复盘调整；' +
    (hasProfile ? '' : '目前还没有完整档案的部分，我不会自行假设。')
  );
}

function detectWeightSafetyResponse({ userText, goalText, bodyProfile = {}, assumeGoalIntent = false }) {
  const text = String(userText || goalText || '').trim();
  if (!text) return null;
  const hasProfile = Number.isFinite(Number(bodyProfile.heightCm)) && Number.isFinite(Number(bodyProfile.currentWeightKg));
  const hasLossIntent = (assumeGoalIntent || EXPLICIT_LOSS_INTENT_REGEX.test(text)) &&
    WEIGHT_LOSS_WORD_REGEX.test(text) && !PAST_LOSS_REGEX.test(text);
  const bmi = calculateBmi(bodyProfile);
  if (hasLossIntent && bmi !== null && bmi < 18.5) {
    return { type: 'bmi_floor', text: buildBmiFloorResponse(bodyProfile, bmi), blocking: true };
  }

  const rate = parseRequestedLossRate(text, { assumeGoalIntent });
  if (rate && rate.kgPerWeek > 1) {
    return { type: 'speed_redline', text: buildSpeedRedlineResponse(rate, hasProfile), blocking: true, rate };
  }

  const reference = parseWeightReference(text, bodyProfile);
  if (reference) {
    return { type: 'scientific_reference', text: buildScientificReferenceResponse(reference), blocking: false, reference };
  }

  if (PROMISE_PRESSURE_REGEX.test(text) && WEIGHT_LOSS_WORD_REGEX.test(text)) {
    return { type: 'promise_pressure', text: buildPromisePressureResponse(hasProfile), blocking: false };
  }
  return null;
}

module.exports = {
  calculateBmi,
  detectWeightSafetyResponse,
  parseChineseNumber,
  parseRequestedLossRate,
  parseWeightReference,
};
