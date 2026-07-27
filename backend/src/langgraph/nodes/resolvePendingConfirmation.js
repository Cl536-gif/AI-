// 待确认解析节点：只在 state.pendingConfirmation 非空时才会被路由到这里
// （见 graph.js 的入口路由）。这一轮用户的回复要优先当作"对上一轮确认问题
// 的回答"来解析：同意就把新值真正落地，不同意就维持旧值，两种情况都清空
// pendingConfirmation；如果回答本身没讲清楚，保留 pendingConfirmation，
// 让 askConfirmation 再问一次，不能不清不楚地就当作已经解决了。
const { z } = require('zod');
const { model } = require('../model');
const { getMessageText, findLastUserMessage } = require('../utils/messages');

const ResolutionSchema = z.object({
  resolution: z
    .enum(['confirmed', 'rejected', 'unclear'])
    .describe(
      'confirmed：用户同意了这次改口/纠正。' +
        'rejected：用户否认了，还是维持原来的值。' +
        'unclear：用户的回答没有明确回应这个确认问题（比如答非所问），需要再问一次。'
    ),
});

const structuredResolver = model.withStructuredOutput(ResolutionSchema, {
  name: 'resolve_pending_confirmation',
});

async function resolvePendingConfirmation(state) {
  const pending = state.pendingConfirmation;
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);

  const prompt = [
    {
      role: 'system',
      content:
        `之前问了用户一个确认问题，大意是："你之前说的是${pending.oldValue}，` +
        `现在是想改成${pending.newValue}吗？"请判断用户这一轮的回复是同意` +
        '（confirmed）、否认（rejected），还是没有明确回应（unclear）。',
    },
    { role: 'human', content: userText },
  ];

  const { resolution } = await structuredResolver.invoke(prompt);

  if (resolution === 'confirmed') {
    return {
      slots: { [pending.field]: { value: pending.newValue, confirmed: true } },
      pendingConfirmation: null,
    };
  }

  if (resolution === 'rejected') {
    return {
      slots: { [pending.field]: { value: pending.oldValue, confirmed: true } },
      pendingConfirmation: null,
    };
  }

  // unclear：什么都不改，pendingConfirmation 保留，交给下游再问一次
  return {};
}

module.exports = { resolvePendingConfirmation };
