const { model } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { findLastUserMessage, getMessageText } = require('../utils/messages');

const SIMPLE_ACK_REGEX = /^(好|好的|好呀|可以|行|知道了|明白了|收到|谢谢|谢谢你)[。！!～~]?$/;

async function answerFollowUp(state) {
  const userText = getMessageText(findLastUserMessage(state.messages)).trim();
  if (SIMPLE_ACK_REGEX.test(userText)) {
    return {
      messages: [{
        role: 'ai',
        content: '那就先按上面的饮食搭配吃着哈～如果实际吃的时候没有这道菜、分量不合适，或者想换成早餐方案，直接告诉我，我再单独帮你调整。',
      }],
    };
  }

  const response = await model.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content:
        '第一版方案和用户档案已经在前文确认过。本轮只回答用户刚提出的问题，或者只调整用户点名的饮食部分。' +
        '不要再次复述六项信息、年龄身高体重、经期记录或整份第一版方案；除非用户明确要求查看档案。',
    },
    ...state.messages,
  ]);
  return { messages: [{ role: 'ai', content: response.content }] };
}

module.exports = { answerFollowUp, SIMPLE_ACK_REGEX };
