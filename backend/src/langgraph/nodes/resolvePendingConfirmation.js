// 待确认解析节点：只在 state.pendingConfirmation 非空时才会被路由到这里
// （见 graph.js 的入口路由）。这一轮用户的回复要优先当作"对上一轮确认问题
// 的回答"来解析：同意就把新值真正落地，不同意就维持旧值，两种情况都清空
// pendingConfirmation；如果回答本身没讲清楚，保留 pendingConfirmation，
// 让 askConfirmation 再问一次，不能不清不楚地就当作已经解决了。
//
// MAX_ASK_COUNT：真实测试发现，如果用户一直不正面回应确认问题、只是
// 继续正常回答别的问题，这个确认会无限期卡住——routeAfterConflictCheck
// 每一轮都会送回askConfirmation原地重复问同一句问题，还会连带卡住
// lastAskedSlot 的推进，导致后续所有"意外字段"都被反复丢弃，表现跟
// 死锁几乎一样。问过 MAX_ASK_COUNT 次还是没能得到明确回应，就不再
// 追问，按"放弃这次确认"处理（跟明确否认时一样恢复原状），把主动权
// 还给对话，让这一轮的真实内容能正常往下走。
const { z } = require('zod');
const { model } = require('../model');
const { getMessageText, findLastUserMessage } = require('../utils/messages');

const MAX_ASK_COUNT = 2;

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
  const isFirstTimeSurprise = pending.oldValue === null;
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);

  const prompt = [
    {
      role: 'system',
      content:
        (isFirstTimeSurprise
          ? '之前问了用户一个确认问题，大意是：从你刚才的话里，好像顺带' +
            `提取到了"${pending.newValue}"这个信息，这样理解对吗？`
          : `之前问了用户一个确认问题，大意是："你之前说的是${pending.oldValue}，` +
            `现在是想改成${pending.newValue}吗？"`) +
        '请判断用户这一轮的回复是同意' +
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

  // 意外字段的首次候选值被否认/放弃时，不能落地成 {value: oldValue,
  // confirmed: true}——oldValue 本来就是 null，那样会把这一项错误地
  // 标记成"已确认但没有值"，之后再也不会被追问。应该完全恢复成
  // 从没发生过一样：{value: null, confirmed: false}，等着被正常问到
  // 或者用户之后再主动提起。
  const revertSlot = () =>
    isFirstTimeSurprise
      ? { value: null, confirmed: false }
      : { value: pending.oldValue, confirmed: true };

  if (resolution === 'rejected') {
    return {
      slots: { [pending.field]: revertSlot() },
      pendingConfirmation: null,
    };
  }

  // unclear：如果已经问过太多次还是没能得到明确回应，不再追问，按
  // "放弃这次确认"处理，避免无限期卡住整个流程；否则保留
  // pendingConfirmation（同时把 askedCount 带上），交给下游再问一次。
  if ((pending.askedCount || 0) >= MAX_ASK_COUNT) {
    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[resolvePendingConfirmation] ${pending.field} 已经问了${pending.askedCount}次还是不清楚，放弃这次确认，恢复原状`);
    }
    return {
      slots: { [pending.field]: revertSlot() },
      pendingConfirmation: null,
    };
  }

  return {};
}

module.exports = { resolvePendingConfirmation };
