// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 复现测试：Bug 1（scene误判）修复验证。
//
// 直接测 extractSlots：场景已确认是"食堂"，用户在回答"口味"问题时，
// 说了"自选"这个词——它不应被误判成scene，而应进入独立的
// cafeteriaMode后台字段。同时测"固定套餐"这个同类型词。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario8-scene-false-trigger.js
const { extractSlots } = require('../nodes/extractSlots');
const { createInitialSlots } = require('../state');

async function testWord(word, expectedMode) {
  const slots = createInitialSlots();
  slots.scene = { value: '食堂', confirmed: true };

  const result = await extractSlots({
    messages: [{ role: 'human', content: word }],
    slots,
    lastAskedSlot: 'taste',
  });

  console.log(`用户说"${word}" -> candidateSlots:`, JSON.stringify(result.candidateSlots));
  const triggeredScene = Object.prototype.hasOwnProperty.call(result.candidateSlots, 'scene');
  const capturedMode = result.candidateSlots.cafeteriaMode === expectedMode;
  console.log(triggeredScene ? '❌ 仍然误判成了scene候选值' : '✅ 没有误判成scene候选值');
  console.log(capturedMode ? `✅ 正确保存为cafeteriaMode=${expectedMode}` : '❌ 没有正确保存食堂打饭方式');
  return !triggeredScene && capturedMode;
}

async function main() {
  console.log('=== 测试1：自选 ===');
  const r1 = await testWord('自选', '自己挑菜');

  console.log('\n=== 测试2：固定套餐 ===');
  const r2 = await testWord('固定套餐', '固定套餐');

  console.log('\n=== 总结 ===');
  console.log(r1 && r2 ? '两个词都正确进入独立后台字段' : '食堂打饭方式抽取仍有问题');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
