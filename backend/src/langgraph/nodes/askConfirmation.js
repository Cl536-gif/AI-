// 确认问题生成节点：conflictRouter 判定为真冲突（correction）之后，
// 这一步负责把 pendingConfirmation 里的信息，转成一句自然口语化的
// 确认问题发给用户，不直接覆盖旧值——等用户回应之后，由
// resolvePendingConfirmation 节点根据用户的回答决定是否真的更新状态。
const { model } = require('../model');
const { SLOT_LABELS } = require('../state');

async function askConfirmation(state) {
  const pending = state.pendingConfirmation;

  const prompt = [
    {
      role: 'system',
      content:
        '你是饮食秘书AI，语气自然口语化，像发微信消息一样，不用emoji、不用' +
        '分点列表，3句话以内。任务：跟用户确认一个疑似改口/纠正的信息，不要' +
        `直接默认这个改动成立。背景：用户之前说的"${SLOT_LABELS[pending.field]}"` +
        `是"${pending.oldValue}"，这一轮看起来是想改成"${pending.newValue}"，请` +
        '生成一句自然的确认问句问清楚这一点。',
    },
  ];

  const response = await model.invoke(prompt);

  return {
    messages: [{ role: 'ai', content: response.content }],
  };
}

module.exports = { askConfirmation };
