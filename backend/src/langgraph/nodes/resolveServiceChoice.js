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

const MAX_ASK_COUNT = 2;

const ChoiceSchema = z.object({
  choice: z
    .enum(['free', 'subscribe', 'unclear'])
    .describe(
      'free：用户选择继续用免费的临时问答模式，不开通推送服务。' +
        'subscribe：用户明确表示想开通/订阅这个定期推送服务。' +
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
        '之前问用户是想用免费的临时饮食问答，还是想开通付费的定期结构化推送服务。' +
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
    return { pendingServiceChoice: { stage: 'schedule', askedCount: 0 } };
  }

  // unclear
  if ((pending.askedCount || 0) >= MAX_ASK_COUNT) {
    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[resolveServiceChoice] 服务选择已经问了${pending.askedCount}次还是不清楚，默认按免费问答处理`);
    }
    return { serviceTier: 'free', pendingServiceChoice: null };
  }
  return {}; // 保留pendingServiceChoice原样，交给askServiceChoice再问一次
}

async function resolveScheduleStage(state, pending) {
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);

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
    return { serviceTier: 'subscribed', pushSchedule: scheduleText, pendingServiceChoice: null };
  }
  if (outcome === 'decline') {
    return { serviceTier: 'free', pendingServiceChoice: null };
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
  return resolveScheduleStage(state, pending);
}

module.exports = { resolveServiceChoice };
