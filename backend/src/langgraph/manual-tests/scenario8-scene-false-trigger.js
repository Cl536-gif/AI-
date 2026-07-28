// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 复现测试：Bug 1（scene误判）修复验证。
//
// 直接测 extractSlots：场景已确认是"食堂"，用户在回答"口味"问题时，
// 说了"自选"这个词——这个词本该完全跟场景无关（它说的是食堂内部的
// 打饭方式，不是食堂/外卖这个场景本身），修复前会被误判成对scene的
// 候选值，触发不必要的确认。同时测"固定套餐"这个同类型的词，确认
// 修复不是只堵住了"自选"这一个具体词。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario8-scene-false-trigger.js
const { extractSlots } = require('../nodes/extractSlots');
const { createInitialSlots } = require('../state');

async function testWord(word) {
  const slots = createInitialSlots();
  slots.scene = { value: '食堂', confirmed: true };

  const result = await extractSlots({
    messages: [{ role: 'human', content: word }],
    slots,
    lastAskedSlot: 'taste',
  });

  console.log(`用户说"${word}" -> candidateSlots:`, JSON.stringify(result.candidateSlots));
  const triggeredScene = Object.prototype.hasOwnProperty.call(result.candidateSlots, 'scene');
  console.log(triggeredScene ? '❌ 仍然误判成了scene候选值（有问题）' : '✅ 没有误判成scene候选值（符合预期）');
  return !triggeredScene;
}

async function main() {
  console.log('=== 测试1：自选 ===');
  const r1 = await testWord('自选');

  console.log('\n=== 测试2：固定套餐 ===');
  const r2 = await testWord('固定套餐');

  console.log('\n=== 总结 ===');
  console.log(r1 && r2 ? '两个词都通过，Bug 1 修复验证成功' : '仍有词触发了误判，Bug 1 没有完全修复');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
