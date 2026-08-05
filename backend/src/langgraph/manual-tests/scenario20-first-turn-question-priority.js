// 不调用模型的确定性回归测试：新对话固定身份介绍，产品问题先回答，
// 然后保留状态机生成的采集问题。
const {
  FIRST_TURN_INTRO,
  CAPABILITY_ANSWER,
  getFixedProductAnswer,
  isFirstConversationTurn,
  composeReplyMessages,
} = require('../nodes/askNextQuestion');

function main() {
  const messages = [{ role: 'human', content: '你能提醒我吗' }];
  if (!isFirstConversationTurn(messages)) throw new Error('没有识别出新对话第一轮');

  const reminderAnswer = getFixedProductAnswer('你能提醒我吗');
  if (!reminderAnswer || !reminderAnswer.includes('长期规划服务')) {
    throw new Error('提醒能力没有使用准确的固定产品回答');
  }

  const replies = composeReplyMessages({
    replyText: '你好呀～那先问你个基础问题：平时吃饭主要是食堂还是外卖呀？',
    fixedProductAnswer: reminderAnswer,
    isFirstTurn: true,
  });

  if (replies.length !== 2) throw new Error('没有拆成两条连续的秘书消息');
  if (!replies[0].startsWith(FIRST_TURN_INTRO)) throw new Error('第一句不是固定身份介绍');
  if ((replies.join('').match(/你好/g) || []).length !== 1) throw new Error('模型问候没有去重');
  if (!replies[0].includes('长期规划服务')) throw new Error('第一条没有回答用户的提醒问题');
  if (!replies[1].includes('食堂还是外卖')) throw new Error('第二条丢失了后续信息采集问题');
  if (!getFixedProductAnswer('你能帮到我什么').includes(CAPABILITY_ANSWER)) {
    throw new Error('能力问题没有命中具体的固定回答');
  }

  console.log('✅ 新对话第一句固定身份介绍');
  console.log('✅ 先回答提醒问题，再继续原有采集进度');
  console.log(replies);
}

try {
  main();
} catch (err) {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
}
