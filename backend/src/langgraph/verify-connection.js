// 验证 qwen-plus 通过 DashScope OpenAI 兼容接口的连通性。
// 注：graph.js 现在已经是六项信息采集的真实状态图（extractSlots →
// conflictRouter → ...），不再是"单节点打招呼"的最小demo，所以这个
// 脚本改成直接测 model.js 本身的连通性，跟状态图的具体节点逻辑无关。
const { model } = require('./model');

async function main() {
  const messages = [
    { role: 'system', content: '你是一个乐于助人的助手。' },
    { role: 'human', content: '你好，请用一句话确认你能正常收到这条消息。' },
  ];

  console.log('[verify-connection] 开始调用 qwen-plus...');

  const response = await model.invoke(messages);

  console.log('[verify-connection] 收到回复:');
  console.log(response.content);
  console.log('[verify-connection] 验证通过');
}

main().catch((err) => {
  console.error('[verify-connection] 验证失败:', err.message);
  process.exit(1);
});
