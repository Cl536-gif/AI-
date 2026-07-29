// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 跟 backend/manual-test-identity.js 的场景B用完全相同的输入
// （"我想减脂"，首次触发认可铁律，紧接着问场景），在 LangGraph 链路
// 上重新跑一次，做真正对等的对照——manual-test-identity.js 那边
// 连续3次生成都命中了"是……还是……"排比句违规，这次看 LangGraph
// 这边在同样的场景下表现是否一致。
//
// 后续更新（完整回归测试时复查）：这条历史违规现在在新老两条架构上
// 都已经不再复现了。定位下来大概率是 bfc73d6（"新增formatGuard.js
// 通用格式兜底机制，接入localChatService和askNextQuestion"，2026-07-27）
// 这次改动带来的效果——它把"是……还是……"排比句纳入了
// detectFormatViolations 的确定性检测（parallel_question类型），
// 命中就自动带着具体问题重试，上限2次，同时接入了 localChatService.js
// 和 askNextQuestion.js 这两条链路。这不是靠改提示词措辞碰巧修好的
// （rule 14"禁止排比反问句式"这条规则本身从项目早期就存在，一直没变），
// 是代码层面的确定性拦截生效了。以后如果这条bug复发，优先去查
// formatGuard.js 的 parallel_question 检测逻辑或它的接入点，而不是
// 去改 systemPrompt.js 里的措辞。
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
