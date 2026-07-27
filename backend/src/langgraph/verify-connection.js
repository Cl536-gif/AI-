// 验证 qwen-plus 通过 DashScope OpenAI 兼容接口的连通性
const { graph } = require('./graph');

async function main() {
  const messages = [
    { role: 'system', content: '你是一个乐于助人的助手。' },
    { role: 'human', content: '你好，请用一句话确认你能正常收到这条消息。' },
  ];

  console.log('[verify-connection] 开始调用 qwen-plus...');

  const result = await graph.invoke({ messages });
  const reply = result.messages[result.messages.length - 1];

  console.log('[verify-connection] 收到回复:');
  console.log(reply.content);
  console.log('[verify-connection] 验证通过');
}

main().catch((err) => {
  console.error('[verify-connection] 验证失败:', err.message);
  process.exit(1);
});
