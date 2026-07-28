// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 复现测试：标准9轮测试里发现的新问题——用户对"身材目标"给出了明确、
// 具体的真实答案"穿衣更好看"（这句话本身就是 goal 字段 schema 描述里
// 给的例子），却被 extractSlots 判成了空，导致 goal 一直没能被确认。
//
// 直接调用 extractSlots，跳过其他节点，排除干扰，专门测这一种输入，
// 多跑几次确认是不是稳定复现，还是偶发的模型异常。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario10-goal-extraction-check.js
const { extractSlots } = require('../nodes/extractSlots');
const { createInitialSlots } = require('../state');

async function runOnce(round) {
  const slots = createInitialSlots();
  slots.scene = { value: '食堂', confirmed: true };
  slots.taste = { value: '偏辣', confirmed: true };
  slots.budget = { value: '20元左右', confirmed: true };
  slots.restrictions = { value: '不吃香菜', confirmed: true };

  const result = await extractSlots({
    messages: [{ role: 'human', content: '穿衣更好看' }],
    slots,
    lastAskedSlot: 'goal',
  });

  console.log(`第${round}次 -> candidateSlots:`, JSON.stringify(result.candidateSlots));
  const ok = result.candidateSlots && Boolean(result.candidateSlots.goal);
  console.log(ok ? '✅ 正确抽取到了goal' : '❌ 没有抽取到goal（复现了问题）');
  return ok;
}

async function main() {
  const results = [];
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runOnce(i));
  }

  const passCount = results.filter(Boolean).length;
  console.log(`\n=== 总结：5次里有 ${passCount} 次正确抽取到了goal ===`);
  if (passCount === 5) {
    console.log('稳定通过，之前那次应该是偶发异常。');
  } else if (passCount === 0) {
    console.log('稳定复现失败，需要针对性修复（可能是护栏描述过度泛化导致的误伤）。');
  } else {
    console.log('不稳定，时好时坏，说明这是个真实存在但不是每次都触发的问题。');
  }
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
