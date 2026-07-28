// 提问节点：checkCompleteness 已经决定好这一轮该问六项里的哪一项
// （state.nextSlotToAsk），这个节点只负责把这个具体问题自然地问出来。
//
// 完整复用 backend/src/services/systemPrompt.js 里现有的全部规则
// （格式铁律13-16、真实性铁律、第25条数字歧义澄清、第42条禁止编造
// 用户原话等），不重新写一套简化版提示词——这些规则是经过大量真实
// 测试验证过的，换成 LangGraph 架构不能把已经解决过的问题重新踩一遍。
//
// 额外只加一句任务说明，告诉模型"这一轮该问哪一项已经由外部状态决定
// 好了，不用自己判断六项采集进度、不用自己决定问题顺序"——避免模型
// 看到完整提示词里第1/4/20/24/32/40条这些"六项采集流程"相关规则后，
// 又自己重新判断一遍进度，跟状态机的决定打架。
const { model } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { generateWithFormatGuard } = require('../../services/formatGuard');
const { SLOT_KEYS, SLOT_LABELS } = require('../state');
const { getMessageRole, getMessageText } = require('../utils/messages');

function formatKnownSlots(slots) {
  const known = SLOT_KEYS.filter((key) => slots[key] && slots[key].value).map((key) => {
    const slot = slots[key];
    return `${SLOT_LABELS[key]}: ${slot.value}${slot.confirmed ? '（已确认）' : '（未确认，待确认中）'}`;
  });
  return known.length > 0 ? known.join('\n') : '（目前还没有任何一项信息）';
}

async function askNextQuestion(state) {
  const nextSlot = state.nextSlotToAsk;
  const slotLabel = SLOT_LABELS[nextSlot];

  const taskInstruction =
    `【本轮任务】六项信息采集里，"${slotLabel}"这一项还没有确认，你这一轮需要` +
    `把这一项问出来。已经确认的信息：\n${formatKnownSlots(state.slots)}\n\n` +
    '六项信息该问哪一项、进度如何，已经由外部状态决定好了（已经明确告诉你要问' +
    `"${slotLabel}"），你不需要自己判断采集进度、不需要自己决定问题顺序，只需要` +
    '结合上面完整的系统规则（对话流程/情绪优先/格式/真实性等所有规则依然全部' +
    '生效），把这一项自然地问出来。\n\n' +
    '【严格禁止】这一轮唯一的任务就是问出这一项缺失的信息，绝对不能在这一轮' +
    '提前给出任何具体的饮食方案、菜品推荐、分量建议——哪怕你觉得已经确认的' +
    '信息看起来已经足够多、已经能大概判断出方案该怎么搭，也必须忍住不要提前' +
    '给。是否已经可以出方案，这个判断已经由外部状态机做出了明确结论（现在' +
    `的结论是"还不能出方案，还差${slotLabel}这一项"），不是由你自己根据` +
    '对话内容判断的，你不需要也不能重新评估这个结论。完整系统规则里如果有' +
    '类似"信息差不多齐了可以先给个初步方向"这类说法，这一轮不适用，以这条' +
    '禁止项为准——提前给方案是这一轮最严重的错误，比问题问得不够自然更严重。';

  const userMessages = state.messages
    .filter((m) => getMessageRole(m) === 'human')
    .map((m) => getMessageText(m));

  const { text: replyText } = await generateWithFormatGuard({
    userMessages,
    generate: async (retryInstruction) => {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: taskInstruction },
        ...(retryInstruction ? [{ role: 'system', content: `【重新生成要求】${retryInstruction}` }] : []),
        ...state.messages,
      ];
      const response = await model.invoke(messages);
      return response.content;
    },
  });

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[askNextQuestion] 问的是: ${nextSlot}`);
    // eslint-disable-next-line no-console
    console.log('[askNextQuestion] 生成的问题:', replyText);
  }

  return {
    messages: [{ role: 'ai', content: replyText }],
    lastAskedSlot: nextSlot,
  };
}

module.exports = { askNextQuestion };
