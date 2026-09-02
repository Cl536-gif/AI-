// 服务选择解析节点：只在 state.pendingServiceChoice 非空时才会被路由到
// 这里（见 graph.js 的入口路由，跟 resolvePendingConfirmation 是同一种
// 用法）。这一轮用户的回复要优先当作"对上一轮服务边界/推送时间问题的
// 回答"来解析。
//
// MAX_ASK_COUNT：跟 resolvePendingConfirmation.js 用的是同一套惯例——
// 含糊问过 MAX_ASK_COUNT 次还是没能得到明确回应，就不再追问。两个阶段
// 各自默认到哪个结果不一样：
// - choice阶段问不清楚：默认按免费问答处理（不能默认开通付费）。
// - schedule阶段问不清楚：这一步用户已经明确选了要开通，只是具体时间
//   没问清楚，不应该因为时间说不清楚就把整个订阅撤销退回免费——按已
//   开通处理，推送时间留空，等用户后续自己去设置。
const { z } = require('zod');
const { classifierModel } = require('../model');
const { getMessageText, findLastUserMessage } = require('../utils/messages');
const { parseExplicitBodyUnits, validateBodyProfile } = require('./resolveBodyOnboarding');

const MAX_ASK_COUNT = 2;
const PAUSE_ONBOARDING_REGEX = /(?:现在|这会儿)?(?:有点|比较|太)?忙|(?:现在|这会儿)?没(?:有)?空|抽不开身|晚点(?:再)?(?:说|填|继续|回来)|今天(?:有空|晚些时候)(?:再)?|先暂停|改天再说/;
const RESUME_ONBOARDING_REGEX = /^(?:继续|继续建档|接着来|接着填|我回来了|现在有空了)[。！!～~]?$/;

const FEMALE_REGEX = /(?:生理)?(?:女性|女(?:生|的)?)(?:身份|用户)?/i;
const MALE_REGEX = /(?:生理)?(?:男性|男(?:生|的)?)(?:身份|用户)?/i;
const MALE_LONG_TERM_UNAVAILABLE_MESSAGE =
  '明白～目前长期饮食定制和阶段调整暂时只面向在校女生，所以这次不能进入长期方案或启动14天试用。' +
  '你仍然可以继续使用免费的科学饮食问答，我也会根据已经了解的信息给你日常饮食建议。';
const EQUATION_SEX_UNCLEAR_FALLBACK_MESSAGE =
  '这项信息还没有确认清楚，为了避免选错计算公式，我先不启动长期方案。' +
  '你仍然可以使用免费的科学饮食问答，之后想继续时再告诉我是生理女性还是生理男性。';

function parseEquationSex(text) {
  const value = String(text || '').trim();
  const isFemale = FEMALE_REGEX.test(value);
  const isMale = MALE_REGEX.test(value);
  if (isFemale === isMale) return null;
  return isFemale ? 'female' : 'male';
}

// 用户刚设定完推送时间这句"已帮你设置好"的呼应，走确定性模板而不是
// 交给generatePlan的LLM调用现场生成——跟价格条款走确定性模板是同一个
// 思路，纯字符串拼接，不需要走formatGuard检测（不含加粗/列表/emoji/
// 排比句这些格式违规的可能）。
function buildScheduleAckMessage(scheduleText) {
  return `已经帮你设置好啦，${scheduleText}会准时给你推送饮食提醒。`;
}

const ChoiceSchema = z.object({
  choice: z
    .enum(['free', 'subscribe', 'unclear'])
    .describe(
      'free：用户选择继续用免费的临时问答模式，不开通推送服务。' +
        'subscribe：用户明确表示想开通长期规划、长期档案、阶段调整或定期推送服务。' +
        'unclear：用户的回复没有明确表明选哪一个（比如答非所问、或者在问别的问题）。'
    ),
});
const structuredChoiceResolver = classifierModel.withStructuredOutput(ChoiceSchema, {
  name: 'resolve_service_choice',
});

const ScheduleSchema = z.object({
  outcome: z
    .enum(['schedule_set', 'decline', 'unclear'])
    .describe(
      'schedule_set：用户给出了具体的提醒时间/频率偏好（不管精度是几点、' +
        '每天还是每周几，只要是在回答时间偏好，都算这个）。' +
        'decline：用户改变主意，不想开通推送服务了。' +
        'unclear：用户的回复没有提供有效的时间信息，也没有明确表示不开通。'
    ),
  scheduleText: z
    .string()
    .nullable()
    .describe('如果outcome是schedule_set，把用户描述的时间偏好原样摘出来；否则填null。'),
});
const structuredScheduleResolver = classifierModel.withStructuredOutput(ScheduleSchema, {
  name: 'resolve_push_schedule',
});

async function resolveChoiceStage(state, pending) {
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);

  const { choice } = await structuredChoiceResolver.invoke([
    {
      role: 'system',
      content:
        '之前问用户是想用免费的科学饮食问答，还是想开通包含长期档案、定期跟进和阶段调整的长期规划服务。' +
        '请判断用户这一轮回复选的是哪一个。',
    },
    { role: 'human', content: userText },
  ]);

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[resolveServiceChoice] choice阶段判断结果: ${choice}`);
  }

  if (choice === 'free') {
    return { serviceTier: 'free', pendingServiceChoice: null };
  }
  if (choice === 'subscribe') {
    return { pendingServiceChoice: { stage: 'equation_sex', askedCount: 0 } };
  }

  // unclear
  // 本轮用户问的明确问题已由 answerDirectQuestion 单独回答
  // （directQuestionAnsweredThisTurn=true）。此时判 unclear 只说明"这句
  // 不是选服务"，不是"没听懂选择"——若走下面的 retry，会在条款答案后面
  // 立刻补一句"没太听明白"，同一轮出现两份答案（MVP 测试图2）。参考
  // resolveScheduleStage 的 deferred 挂起惯例（earlyBody 接住同理）：
  // 把选择问题挂起到下一轮，本轮就此收口；flag 用后清零，防 checkpoint
  // 跨轮泄漏导致下一轮真含糊也被误挂起。
  if (state.directQuestionAnsweredThisTurn) {
    return {
      pendingServiceChoice: { ...pending, deferred: true },
      directQuestionAnsweredThisTurn: false,
    };
  }
  if ((pending.askedCount || 0) >= MAX_ASK_COUNT) {
    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[resolveServiceChoice] 服务选择已经问了${pending.askedCount}次还是不清楚，默认按免费问答处理`);
    }
    return { serviceTier: 'free', pendingServiceChoice: null };
  }
  return {}; // 保留pendingServiceChoice原样，交给askServiceChoice再问一次
}

async function resolveEquationSexStage(state, pending) {
  const userText = getMessageText(findLastUserMessage(state.messages));
  const equationSex = parseEquationSex(userText);
  if (equationSex === 'female') {
    return {
      equationSex,
      pendingServiceChoice: { stage: 'schedule', askedCount: 0 },
    };
  }
  if (equationSex === 'male') {
    return {
      messages: [{ role: 'ai', content: MALE_LONG_TERM_UNAVAILABLE_MESSAGE }],
      equationSex,
      serviceTier: 'free',
      pushSchedule: null,
      pendingServiceChoice: null,
    };
  }
  if ((pending.askedCount || 0) >= MAX_ASK_COUNT) {
    return {
      messages: [{ role: 'ai', content: EQUATION_SEX_UNCLEAR_FALLBACK_MESSAGE }],
      equationSex: null,
      serviceTier: 'free',
      pushSchedule: null,
      pendingServiceChoice: null,
    };
  }
  return {};
}

async function resolveScheduleStage(state, pending) {
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);

  if (PAUSE_ONBOARDING_REGEX.test(userText)) {
    return {
      messages: [{
        role: 'ai',
        content: '没问题，那我先把今天这顿的搭配给你。剩下的资料今天有空时跟我说“继续建档”就行，前面说过的信息不用重填。',
      }],
      serviceTier: 'subscribed',
      pushSchedule: null,
      pendingServiceChoice: null,
      bodyOnboardingStatus: 'required_missing',
      pendingBodyOnboarding: { stage: 'collecting', askedCount: 0, paused: true },
    };
  }

  if (pending.paused && RESUME_ONBOARDING_REGEX.test(userText)) {
    return {
      messages: [{ role: 'ai', content: '好，我们从上次停下的位置接着来哈。' }],
      pendingServiceChoice: { ...pending, paused: false, deferred: false },
    };
  }

  // 用户可能没有按提问顺序回答。即使当前正在等提醒时间，也要先接住
  // 同一条消息里明确给出的年龄、身高和体重，不能把有效答案当成答非所问。
  const earlyBody = validateBodyProfile(parseExplicitBodyUnits(userText));
  const mergedBodyProfile = { ...(state.bodyProfile || {}), ...earlyBody };
  const hasScheduleEvidence = /(?:每天|隔天|工作日|周末|每周|提醒|上午|中午|下午|晚上|早上|\d{1,2}\s*[点时:：])/.test(userText);
  if (Object.keys(earlyBody).length && !hasScheduleEvidence) {
    const labels = [];
    if (earlyBody.ageYears != null) labels.push(`${earlyBody.ageYears}岁`);
    if (earlyBody.heightCm != null) labels.push(`身高${earlyBody.heightCm}厘米`);
    if (earlyBody.currentWeightKg != null) labels.push(`当前体重${earlyBody.currentWeightKg}公斤`);
    return {
      messages: [{
        role: 'ai',
        content: `这些基础信息我先记下了：${labels.join('、')}。提醒频率和时间还没确定，等你方便时再告诉我就行。`,
      }],
      bodyProfile: mergedBodyProfile,
      pendingServiceChoice: { ...pending, deferred: true },
    };
  }

  const { outcome, scheduleText } = await structuredScheduleResolver.invoke([
    {
      role: 'system',
      content:
        '之前问用户想设定什么时候/多久提醒一次推送。请判断用户这一轮回复有没有给出' +
        '有效的时间偏好，还是改变主意不想开通了，还是没讲清楚。',
    },
    { role: 'human', content: userText },
  ]);

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[resolveServiceChoice] schedule阶段判断结果: ${outcome}, scheduleText: ${scheduleText}`);
  }

  if (outcome === 'schedule_set') {
    return {
      serviceTier: 'subscribed',
      pushSchedule: scheduleText,
      pendingServiceChoice: null,
      pendingServiceAck: buildScheduleAckMessage(scheduleText),
      ...(Object.keys(earlyBody).length ? { bodyProfile: mergedBodyProfile } : {}),
    };
  }
  if (outcome === 'decline') {
    return {
      serviceTier: 'free', pendingServiceChoice: null,
      ...(Object.keys(earlyBody).length ? { bodyProfile: mergedBodyProfile } : {}),
    };
  }

  if (Object.keys(earlyBody).length) {
    const labels = [];
    if (earlyBody.ageYears != null) labels.push(`${earlyBody.ageYears}岁`);
    if (earlyBody.heightCm != null) labels.push(`身高${earlyBody.heightCm}厘米`);
    if (earlyBody.currentWeightKg != null) labels.push(`当前体重${earlyBody.currentWeightKg}公斤`);
    return {
      messages: [{
        role: 'ai',
        content: `这些基础信息我先记下了：${labels.join('、')}。提醒频率和时间还没确定，等你方便时再告诉我就行。`,
      }],
      bodyProfile: mergedBodyProfile,
      pendingServiceChoice: { ...pending, deferred: true },
    };
  }

  // unclear：已经明确选了开通，只是时间没说清楚，不退回免费，按已开通处理
  if ((pending.askedCount || 0) >= MAX_ASK_COUNT) {
    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[resolveServiceChoice] 推送时间已经问了${pending.askedCount}次还是不清楚，按已开通处理，时间留空待后续设置`);
    }
    return { serviceTier: 'subscribed', pushSchedule: null, pendingServiceChoice: null };
  }
  return {}; // 保留pendingServiceChoice原样，交给askServiceChoice再问一次
}

async function resolveServiceChoice(state) {
  const pending = state.pendingServiceChoice;
  if (pending.stage === 'choice') {
    return resolveChoiceStage(state, pending);
  }
  if (pending.stage === 'equation_sex') {
    return resolveEquationSexStage(state, pending);
  }
  return resolveScheduleStage(state, pending);
}

module.exports = {
  resolveServiceChoice,
  resolveEquationSexStage,
  parseEquationSex,
  MALE_LONG_TERM_UNAVAILABLE_MESSAGE,
  EQUATION_SEX_UNCLEAR_FALLBACK_MESSAGE,
};
