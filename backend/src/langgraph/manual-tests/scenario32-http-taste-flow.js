// 通过真实 HTTP 接口自动走完“场景 -> 食堂方式 -> 口味 -> 补充口味”，
// 覆盖 checkpointer、路由层 replies 数组和完整图状态，不需要人工逐轮点击。
const CHAT_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';

async function send(message, threadId) {
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, threadId }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function main() {
  let threadId;
  let result;
  for (const message of ['你好', '食堂', '自选', '小炒肉', '对，另外也喜欢甜的']) {
    // eslint-disable-next-line no-await-in-loop
    result = await send(message, threadId);
    threadId = result.threadId;
    console.log(`用户: ${message}`);
    console.log(`秘书: ${(result.replies || [result.reply]).join(' | ')}`);
  }

  const taste = result.slots?.taste;
  if (!taste?.confirmed || !taste.value.includes('小炒肉') || !taste.value.includes('甜味')) {
    throw new Error(`HTTP完整流程没有保存两个口味信息: ${JSON.stringify(taste)}`);
  }
  const combinedReplies = (result.replies || []).join('\n');
  if (!combinedReplies.includes('甜味')) throw new Error('HTTP回复没有向用户复述新增甜味');
  if (combinedReplies.includes('改成')) throw new Error('HTTP回复仍把新增口味当成替换');
  if (combinedReplies.includes('前面问你的问题')) throw new Error('当前问题已完成却错误返回所谓前一个问题');

  console.log(`✅ HTTP状态最终保存: ${taste.value}`);
  console.log('✅ replies 数组包含新增口味确认和后续问题');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
