const { SERVICE_CHOICE_RETRY_MESSAGE } = require('../nodes/askServiceChoice');
const { routeAfterServiceChoice } = require('../graph');

async function main() {
  // answerDirectQuestion 已经在同轮发出的产品边界答复。这里只验证
  // resolveServiceChoice 留下 deferred 后，图不会继续进入固定重问节点。
  const directAnswer = '可以，之后仍然可以选择长期规划服务。';

  const stateAfterClarification = {
    messages: [{ role: 'ai', content: directAnswer }],
    pendingServiceChoice: { stage: 'choice', askedCount: 1, deferred: true },
    directQuestionAnsweredThisTurn: false,
  };
  const route = routeAfterServiceChoice(stateAfterClarification);
  if (route !== '__end__') throw new Error(`已回答产品问题后仍路由到：${route}`);
  if (stateAfterClarification.messages.some((message) => message.content === SERVICE_CHOICE_RETRY_MESSAGE)) {
    throw new Error('同轮出现了服务选择固定重问');
  }

  console.log('✅ 产品问题回答后本轮直接结束，保留 pending 且不发服务选择重问');
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});
