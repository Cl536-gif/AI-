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
// 完整回归测试时复现过一次失败（被硬猜成了budget="20元左右"）——
// extractSlots.js 这次完全没被改动过，怀疑是 model.js 里
// temperature:0.7 带来的随机性正好撞在这种边界判断上，不是新引入的
// 回归。改成跑5次、统计命中率，跟 scenario10 用的是同一个方法，确认
// 这是稳定复现还是偶发。
//
// 运行：cd backend && node src/langgraph/manual-tests/scenario4-ambiguous-number.js
const { extractSlots } = require('../nodes/extractSlots');
const { createInitialSlots } = require('../state');

async function runOnce(round) {
  const result = await extractSlots({
    messages: [{ role: 'human', content: '20' }],
    slots: createInitialSlots(),
    lastAskedSlot: null, // 关键：没有任何"上一轮问的是什么"这个线索
  });

  const isEmpty = Object.keys(result.candidateSlots || {}).length === 0;
  console.log(`第${round}次 -> candidateSlots:`, JSON.stringify(result.candidateSlots));
  console.log(isEmpty ? '✅ 正确保持为空（没有瞎猜）' : '❌ 硬猜了某一项（复现了问题）');
  return isEmpty;
}

async function main() {
  console.log('=== 用户在没有任何上下文铺垫的情况下，突然只说了"20"（连续跑5次） ===\n');

  const results = [];
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runOnce(i));
  }

  const passCount = results.filter(Boolean).length;
  console.log(`\n=== 总结：5次里有 ${passCount} 次正确保持为空 ===`);
  if (passCount === 5) {
    console.log('稳定通过，之前那次应该是偶发的模型随机性，不用特别处理。');
  } else if (passCount === 0) {
    console.log('稳定复现失败，需要针对性修复（budget字段的语境判断描述可能不够强）。');
  } else {
    console.log(`不稳定，命中率${passCount}/5，说明这是个真实存在但不是每次都触发的边界问题，建议后续加固。`);
  }
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
