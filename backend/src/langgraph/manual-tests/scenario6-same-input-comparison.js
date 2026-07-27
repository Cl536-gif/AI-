// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 跟 backend/manual-test-identity.js 的场景B用完全相同的输入
// （"我想减脂"，首次触发认可铁律，紧接着问场景），在 LangGraph 链路
// 上重新跑一次，做真正对等的对照——manual-test-identity.js 那边
// 连续3次生成都命中了"是……还是……"排比句违规，这次看 LangGraph
// 这边在同样的场景下表现是否一致。
//
// 运行：cd backend && FORMAT_GUARD_DEBUG=1 node src/langgraph/manual-tests/scenario6-same-input-comparison.js
const { askNextQuestion } = require('../nodes/askNextQuestion');
const { createInitialSlots } = require('../state');

async function main() {
  const state = {
    messages: [{ role: 'human', content: '我想减脂' }],
    slots: createInitialSlots(),
    nextSlotToAsk: 'scene',
    lastAskedSlot: null,
  };

  const result = await askNextQuestion(state);
  const text = result.messages[0].content;

  console.log('=== 生成的开场白 ===');
  console.log(text);

  const hasParallelQuestion = /是[^。！？!?]*[，,][^。！？!?]*还是[^？?]*[？?]/.test(text);
  console.log('\n是否出现"是……还是……"排比句:', hasParallelQuestion ? '是（有问题）' : '否（符合预期）');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
