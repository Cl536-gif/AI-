const { z } = require('zod');
const { classifierModel } = require('../model');
const { findLastUserMessage, getMessageText } = require('../utils/messages');
const { CYCLE_ONBOARDING_QUESTION } = require('./generatePlan');

const DECLINE_REGEX = /(不想|不用|不需要|暂时不|先不|跳过|拒绝|不方便|以后再说)/;
const PAUSE_ONBOARDING_REGEX = /(?:现在|这会儿)?(?:有点|比较|太)?忙|(?:现在|这会儿)?没(?:有)?空|抽不开身|晚点(?:再)?(?:说|填|继续|回来)|今天(?:有空|晚些时候)(?:再)?|先暂停|改天再说/;
const RESUME_ONBOARDING_REGEX = /^(?:继续|继续建档|接着来|接着填|我回来了|现在有空了)[。！!～~]?$/;
const CONFIRM_REGEX = /^(对|是|是的|没错|正确|确认|就是这样)[。！!～~]?$/;
const REQUIRED_KEYS = ['ageYears', 'heightCm', 'currentWeightKg', 'dailyActivity'];
const FIELD_LABELS = {
  ageYears: '年龄',
  heightCm: '身高',
  currentWeightKg: '当前体重',
  dailyActivity: '平时活动情况',
};

const BodyProfileSchema = z.object({
  ageYears: z.number().nullable().describe('年龄，单位岁；没有明确提供则填null。'),
  heightCm: z.number().nullable().describe('身高，统一换算为厘米；没有明确提供则填null。'),
  currentWeightKg: z.number().nullable().describe('当前体重，统一换算为千克；没有明确提供则填null。'),
  targetWeightKg: z.number().nullable().describe('目标体重，统一换算为千克；没有明确提供则填null。'),
  dailyActivity: z
    .string()
    .nullable()
    .describe('日常活动情况，例如久坐为主、走动较多；只保存用户明确提供的内容。'),
  recentWeightChange: z
    .string()
    .nullable()
    .describe('近期体重变化及时间范围；只保存用户明确提供的内容。'),
});

const structuredBodyExtractor = classifierModel.withStructuredOutput(BodyProfileSchema, {
  name: 'extract_body_profile',
});

function compactProfile(profile) {
  return Object.fromEntries(Object.entries(profile || {}).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

const DAILY_ACTIVITY_EVIDENCE_REGEX = /(久坐|坐着|走动|站立|活动量|上课|上班|通勤|体力劳动|每天[^。！？]{0,10}(?:步|走)|步数)/;

function sanitizeBodyExtractionByEvidence(extracted, userText = '') {
  const cleaned = { ...(extracted || {}) };
  // 真实模型曾在只有“20kg, 165cm 22岁”的回答里自行补出活动量，导致
  // 建档提前完成、正式计算时才报错。活动量必须有用户本轮原文证据。
  if (!DAILY_ACTIVITY_EVIDENCE_REGEX.test(String(userText))) delete cleaned.dailyActivity;
  return cleaned;
}

function missingRequiredFields(profile) {
  return REQUIRED_KEYS.filter((key) => profile[key] === null || profile[key] === undefined);
}

function validateBodyProfile(profile) {
  const cleaned = { ...profile };
  if (cleaned.ageYears != null && (cleaned.ageYears < 14 || cleaned.ageYears > 100)) delete cleaned.ageYears;
  if (cleaned.heightCm != null && (cleaned.heightCm < 120 || cleaned.heightCm > 230)) delete cleaned.heightCm;
  if (cleaned.currentWeightKg != null && (cleaned.currentWeightKg < 10 || cleaned.currentWeightKg > 500)) delete cleaned.currentWeightKg;
  if (cleaned.targetWeightKg != null && (cleaned.targetWeightKg < 10 || cleaned.targetWeightKg > 500)) delete cleaned.targetWeightKg;
  return cleaned;
}

function parseExplicitBodyUnits(userText) {
  const text = String(userText || '')
    .replace(/，/g, ',')
    .replace(/k\s*g\b/gi, 'kg')
    .replace(/c\s*m\b/gi, 'cm')
    .replace(/l\s*b\s*s?\b/gi, 'lbs');
  const result = {};
  const ageMatch = text.match(/(?:年龄\s*[:：]?\s*(\d{1,3})(?!\s*(?:cm|厘米|公分|m|米|kg|公斤|斤|lb|磅))|(\d{1,3})\s*(?:周?岁|岁数))/i);
  if (ageMatch) result.ageYears = Number(ageMatch[1] || ageMatch[2]);

  const heightMatch = text.match(/(\d+(?:\.\d+)?)\s*(cm|厘米|公分|m|米|inch(?:es)?|in|英寸)/i);
  if (heightMatch) {
    const value = Number(heightMatch[1]);
    const unit = heightMatch[2].toLowerCase();
    if (['cm', '厘米', '公分'].includes(unit)) result.heightCm = value;
    else if (['m', '米'].includes(unit)) result.heightCm = value * 100;
    else result.heightCm = value * 2.54;
  }

  const weightMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(kg|kgs|公斤|千克|斤|g|克|lbs?|pounds?|磅)/gi)];
  const targetContext = /(目标|希望|想到|减到)/;
  weightMatches.forEach((match) => {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    let kg;
    if (['kg', 'kgs', '公斤', '千克'].includes(unit)) kg = value;
    else if (unit === '斤') kg = value / 2;
    else if (unit === 'g' || unit === '克') kg = value / 1000;
    else kg = value * 0.45359237;
    const prefix = text.slice(Math.max(0, match.index - 6), match.index);
    const key = targetContext.test(prefix) ? 'targetWeightKg' : 'currentWeightKg';
    result[key] = Math.round(kg * 100) / 100;
  });
  return result;
}

function findImplausibleBodyValue(profile) {
  if (profile.currentWeightKg != null && (profile.currentWeightKg < 25 || profile.currentWeightKg > 300)) {
    return `当前体重${profile.currentWeightKg}公斤`;
  }
  if (profile.heightCm != null && profile.currentWeightKg != null) {
    const bmi = profile.currentWeightKg / ((profile.heightCm / 100) ** 2);
    if (bmi < 10 || bmi > 80) return `身高${profile.heightCm}厘米、当前体重${profile.currentWeightKg}公斤`;
  }
  return null;
}

function mergeBodyProfileForTurn(state, extracted, explicitUnits) {
  const pendingCandidate = state.pendingBodyOnboarding?.stage === 'confirm_implausible'
    ? (state.pendingBodyOnboarding.candidateProfile || {})
    : {};
  return validateBodyProfile({
    ...(state.bodyProfile || {}),
    ...pendingCandidate,
    ...extracted,
    ...explicitUnits,
  });
}

async function resolveBodyOnboarding(state) {
  const userText = getMessageText(findLastUserMessage(state.messages)).trim();

  function proceedToCycle(extra = {}) {
    return {
      ...extra,
      messages: [
        ...(extra.messages || []),
        { role: 'ai', content: CYCLE_ONBOARDING_QUESTION },
      ],
      bodyOnboardingStatus: extra.bodyOnboardingStatus || 'completed',
      pendingBodyOnboarding: null,
      cycleOnboardingStatus: 'asked',
      pendingCycleOnboarding: { askedCount: 1 },
    };
  }

  if (PAUSE_ONBOARDING_REGEX.test(userText)) {
    return {
      messages: [{ role: 'ai', content: '好，今天有空时跟我说“继续建档”就行，我会从还没填的地方接着问，前面已经说过的信息不用重填。' }],
      bodyOnboardingStatus: 'required_missing',
      pendingBodyOnboarding: {
        ...(state.pendingBodyOnboarding || {}),
        stage: 'collecting',
        paused: true,
      },
    };
  }

  if (state.pendingBodyOnboarding?.paused && RESUME_ONBOARDING_REGEX.test(userText)) {
    const missing = missingRequiredFields(state.bodyProfile || {});
    return {
      messages: [{ role: 'ai', content: `好，我们接着上次没填完的来哈。还差${missing.map((key) => FIELD_LABELS[key]).join('、')}，直接告诉我就可以。` }],
      pendingBodyOnboarding: {
        ...state.pendingBodyOnboarding,
        paused: false,
      },
    };
  }

  if (DECLINE_REGEX.test(userText)) {
    return {
      messages: [{ role: 'ai', content: '明白。不过基础身体数据和日常活动情况是长期规划计算需要的建档信息；在补齐前，我不会启动长期方案或14天试用。你今天方便时再回来继续填写就好。' }],
      bodyOnboardingStatus: 'required_missing',
      pendingBodyOnboarding: {
        stage: 'collecting',
        askedCount: (state.pendingBodyOnboarding?.askedCount || 1) + 1,
      },
    };
  }

  if (state.pendingBodyOnboarding?.stage === 'confirm_implausible' && CONFIRM_REGEX.test(userText)) {
    const confirmedProfile = state.pendingBodyOnboarding.candidateProfile;
    const missingAfterConfirm = missingRequiredFields(confirmedProfile);
    if (missingAfterConfirm.length === 0) {
      const summary = `${confirmedProfile.ageYears}岁、身高${confirmedProfile.heightCm}厘米、当前体重${confirmedProfile.currentWeightKg}公斤`;
      return proceedToCycle({
        messages: [{ role: 'ai', content: `确认记下：${summary}。后续计算会统一使用换算后的单位。` }],
        bodyProfile: confirmedProfile,
      });
    }
  }

  const extracted = compactProfile(sanitizeBodyExtractionByEvidence(await structuredBodyExtractor.invoke([
    {
      role: 'system',
      content:
        '从用户这一轮回答中提取长期饮食规划所需的身体数据。用户可能按提问顺序只回复几个数字，' +
        '提问顺序是年龄、身高、当前体重。斤必须换算成千克（2斤=1千克）。不要猜测用户没有说的信息。',
    },
    { role: 'human', content: userText },
  ]), userText));
  const explicitUnits = parseExplicitBodyUnits(userText);
  // 用户确认可疑值时可以只发更正项，例如上一轮“20kg, 165cm, 22岁”，
  // 这一轮只改成“80公斤”。必须以待确认候选档案为底稿再覆盖更正值，
  // 不能把同一句里已经识别出的年龄和身高一起丢掉。
  const mergedProfile = mergeBodyProfileForTurn(state, extracted, explicitUnits);
  const implausibleValue = findImplausibleBodyValue(mergedProfile);
  if (implausibleValue) {
    return {
      messages: [{
        role: 'ai',
        content: `我已经识别到你填写的是${implausibleValue}。这个数值会明显影响后台计算，我不会直接当成错误丢掉；请确认单位和数字是否正确。正确就回复“确认”，需要修改就直接发新数值。`,
      }],
      pendingBodyOnboarding: {
        stage: 'confirm_implausible',
        askedCount: (state.pendingBodyOnboarding?.askedCount || 1) + 1,
        candidateProfile: mergedProfile,
      },
    };
  }
  const missing = missingRequiredFields(mergedProfile);

  if (missing.length === 0) {
    const summary = `${mergedProfile.ageYears}岁、身高${mergedProfile.heightCm}厘米、当前体重${mergedProfile.currentWeightKg}公斤`;
    return proceedToCycle({
      messages: [{
        role: 'ai',
        content:
          `记下啦：${summary}。平时如果有额外运动，比如跑步、健身或打球，记得当天告诉我大概做了多久；` +
          '如果手表有消耗数据，也可以一起发来，我会把它作为参考调整当天的饮食。',
      }],
      bodyProfile: mergedProfile,
    });
  }

  const askedCount = state.pendingBodyOnboarding?.askedCount || 1;
  if (askedCount >= 3) {
    return {
      messages: [{ role: 'ai', content: `目前能确认的数据我先记下了，还差${missing.map((key) => FIELD_LABELS[key]).join('、')}。这几项会直接影响长期规划计算，补齐前不会启动长期方案或14天试用；你今天方便时再回来继续填写就好。` }],
      bodyProfile: mergedProfile,
      bodyOnboardingStatus: 'required_missing',
      pendingBodyOnboarding: { stage: 'collecting', askedCount: askedCount + 1 },
    };
  }

  return {
    messages: [{ role: 'ai', content: `我已经记下刚才说清楚的部分～还差${missing.map((key) => FIELD_LABELS[key]).join('、')}，直接把这几项告诉我就可以。` }],
    bodyProfile: mergedProfile,
    pendingBodyOnboarding: { askedCount: askedCount + 1 },
  };
}

module.exports = {
  resolveBodyOnboarding,
  missingRequiredFields,
  validateBodyProfile,
  parseExplicitBodyUnits,
  findImplausibleBodyValue,
  mergeBodyProfileForTurn,
  sanitizeBodyExtractionByEvidence,
};
