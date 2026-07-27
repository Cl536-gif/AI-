// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 场景：用户没头没脑地孤立给出一个数字，且没有任何上下文线索能确定
// 这个数字对应六项里的哪一项（对应 systemPrompt.js 第25条"语境不明确
// 时不能瞎猜"这条边界）。
//
// 注意：在当前的 LangGraph 架构里，"是否要澄清"这件事目前落在
// extractSlots 这一步——extractSlots 只有 null 或具体候选值两种选项，
// 没有"需要澄清"这个第三态，所以正确的预期行为是：extractSlots 在
// 完全没有上下文线索时，应该对所有六项都填 null（不强行归到某一项），
// 而不是随便挑一项瞎猜。这样后续 askNextQuestion 就会正常按原计划
// 继续问该问的那一项，相当于变相达成"没有被这个孤立数字带偏"的效果。
//
// 运行：cd backend && node src/langgraph/manual-tests/scenario4-ambiguous-number.js
const { extractSlots } = require('../nodes/extractSlots');
const { createInitialSlots } = require('../state');

async function main() {
  console.log('=== 用户在没有任何上下文铺垫的情况下，突然只说了"20" ===');
  const result = await extractSlots({
    messages: [{ role: 'human', content: '20' }],
    slots: createInitialSlots(),
    lastAskedSlot: null, // 关键：没有任何"上一轮问的是什么"这个线索
  });

  console.log('抽取到的候选值:', JSON.stringify(result.candidateSlots));
  console.log('\n--- 预期：candidateSlots 应该是空对象 {}（六项都填了null，没有强行' +
    '把"20"归到某一项），不应该出现任何一项被硬猜成"20" ---');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
