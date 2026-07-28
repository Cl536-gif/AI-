// 确认问题生成节点：conflictRouter 判定需要确认之后（真冲突/改口，或者
// 意外字段的首次候选值），这一步负责把 pendingConfirmation 里的信息，
// 转成一句自然口语化的确认问题发给用户，不直接落地——等用户回应之后，
// 由 resolvePendingConfirmation 节点根据用户的回答决定是否真的更新状态。
//
// pending.oldValue 为 null 时，表示这不是"改口"，而是 AI 本轮没有问、
// 但 candidateSlots 里意外冒出来的候选值（第一次出现，没有旧值可比较），
// 这种情况的确认问法跟"改口确认"不一样，要分开处理。
const { model } = require('../model');
const { SLOT_LABELS } = require('../state');

async function askConfirmation(state) {
  const pending = state.pendingConfirmation;
  const isFirstTimeSurprise = pending.oldValue === null;

  const prompt = [
    {
      role: 'system',
      content:
        '你是饮食秘书AI，语气自然口语化，像发微信消息一样，不用emoji、不用' +
        '分点列表，3句话以内。' +
        (isFirstTimeSurprise
          ? '任务：这一轮AI本来问的是别的问题，但从用户这句话里，似乎顺带' +
            `提取到了关于"${SLOT_LABELS[pending.field]}"的信息："${pending.newValue}"` +
            '。这一项用户之前没有明确说过，不确定这次理解得对不对，也不确定' +
            '用户是不是真的在主动说这件事。请生成一句自然的确认问句，跟用户' +
            '核实一下这个理解对不对，不要直接当成用户已经确认过的信息来聊。'
          : '任务：跟用户确认一个疑似改口/纠正的信息，不要直接默认这个改动' +
            `成立。背景：用户之前说的"${SLOT_LABELS[pending.field]}"是` +
            `"${pending.oldValue}"，这一轮看起来是想改成"${pending.newValue}"，` +
            '请生成一句自然的确认问句问清楚这一点。'),
    },
  ];

  const response = await model.invoke(prompt);

  return {
    messages: [{ role: 'ai', content: response.content }],
  };
}

module.exports = { askConfirmation };
