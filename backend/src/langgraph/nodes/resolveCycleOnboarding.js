const { z } = require('zod');
const { classifierModel } = require('../model');
const { findLastUserMessage, getMessageText } = require('../utils/messages');

const DECLINE_REGEX = /(不想|不用|不需要|暂时不|先不|跳过|拒绝|不记录|没有月经|不方便)/;

const CycleProfileSchema = z.object({
  regularity: z.enum(['regular', 'irregular', 'unknown']).describe('用户说规律填regular，不规律填irregular，没说填unknown。'),
  startDates: z.array(z.string()).describe('用户明确提供的月经开始日期原文；没有就空数组。'),
  typicalCycleDays: z.number().nullable().describe('用户明确说通常间隔多少天才填写，否则null。'),
  symptoms: z.array(z.string()).describe('经期前后明确提到的食欲或身体症状；没有就空数组。'),
});

const structuredCycleExtractor = classifierModel.withStructuredOutput(CycleProfileSchema, {
  name: 'extract_cycle_profile',
});

const CYCLE_RETRY_MESSAGE =
  '为了避免把日期猜得太准，我还需要确认：\n\n' +
  '1. 周期大致规律还是不规律\n' +
  '2. 最近一次月经开始日期\n' +
  '3. 如果不规律，尽量再提供前一到两次开始日期，或者大概间隔天数\n\n' +
  '不记得可以直接说“不记得”，不想记录也可以回复“跳过”。';

// 日期是建档里的关键原始数据，不能把是否识别成功完全交给模型。
// 这里只保留用户明确写出的“X月X日/号”原文，不推算年份，也不会把
// “来了三个月”误认成周期长度或三个日期。
function extractExplicitCycleDates(userText = '') {
  const matches = String(userText).match(/(?:今年|去年|本月|上月|上个月|前一次|上一次|大约|约)?\s*\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)/g) || [];
  return [...new Set(matches.map((value) => value.replace(/\s+/g, '').trim()))];
}

function mergeCycleProfile(existing = {}, extracted = {}, userText = '') {
  return {
    regularity: extracted.regularity !== 'unknown' ? extracted.regularity : (existing.regularity || 'unknown'),
    startDates: [...new Set([...(existing.startDates || []), ...(extracted.startDates || [])])],
    typicalCycleDays: extracted.typicalCycleDays ?? existing.typicalCycleDays ?? null,
    symptoms: [...new Set([...(existing.symptoms || []), ...(extracted.symptoms || [])])],
    userReportedTexts: [...(existing.userReportedTexts || []), userText],
  };
}

function cycleProfileNeedsMore(profile) {
  if (profile.regularity === 'unknown') return true;
  if (profile.startDates.length === 0) return true;
  if (profile.regularity === 'irregular' && profile.startDates.length < 2 && !profile.typicalCycleDays) return true;
  return false;
}

function buildCycleRecordAck(profile) {
  return (
    '好～后面我会结合你的周期记录和实际状态，适当调整餐食搭配，' +
    '帮助你更稳地应对容易饿、疲劳或腹胀这些变化。'
  );
}

async function resolveCycleOnboarding(state) {
  const userText = getMessageText(findLastUserMessage(state.messages)).trim();
  if (DECLINE_REGEX.test(userText)) {
    return {
      messages: [{
        role: 'ai',
        content: '明白。不过经期和近期身体状态是当前女生长期规划需要完成的建档信息；在这项完成前，我不会启动长期方案或14天试用。你今天方便时再回来继续填写就好。',
      }],
      cycleOnboardingStatus: 'required_missing',
      pendingCycleOnboarding: {
        askedCount: (state.pendingCycleOnboarding?.askedCount || 1) + 1,
      },
    };
  }

  const extracted = await structuredCycleExtractor.invoke([
    {
      role: 'system',
      content:
        '只提取用户明确说出的经期规律性、月经开始日期、通常间隔天数和症状。' +
        '“来了三个月”不是周期长度，也不是三个开始日期，不能把它编造成日期或周期。不要自行推算。',
    },
    { role: 'human', content: userText },
  ]);
  extracted.startDates = [
    ...new Set([...(extracted.startDates || []), ...extractExplicitCycleDates(userText)]),
  ];
  const profile = mergeCycleProfile(state.menstrualProfile || {}, extracted, userText);

  if (!cycleProfileNeedsMore(profile)) {
    return {
      messages: [{ role: 'ai', content: buildCycleRecordAck(profile) }],
      menstrualProfile: profile,
      cycleOnboardingStatus: 'completed',
      pendingCycleOnboarding: null,
    };
  }

  const askedCount = state.pendingCycleOnboarding?.askedCount || 1;
  if (askedCount >= 3) {
    return {
      messages: [{ role: 'ai', content: '目前能确认的信息我先记下，但数据还不足以估算可靠范围。以后每次月经开始时告诉我日期，我会逐步更新记录。' }],
      menstrualProfile: profile,
      cycleOnboardingStatus: 'partial',
      pendingCycleOnboarding: null,
    };
  }

  return {
    messages: [{ role: 'ai', content: CYCLE_RETRY_MESSAGE }],
    menstrualProfile: profile,
    pendingCycleOnboarding: { askedCount: askedCount + 1 },
  };
}

module.exports = {
  resolveCycleOnboarding,
  mergeCycleProfile,
  cycleProfileNeedsMore,
  buildCycleRecordAck,
  CYCLE_RETRY_MESSAGE,
  extractExplicitCycleDates,
};
