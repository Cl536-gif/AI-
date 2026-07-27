// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 场景2：误判排除——已确认场景是"外卖"，AI这一轮实际在问"忌口"，
// 用户回答忌口问题时顺嘴提到了"食堂"这个词，但不是真的想把场景改成
// 食堂。应该确认 conflictRouter 不会因此误触发确认流程（pendingConfirmation
// 应该保持 null，slots.scene 应该保持不变）。
//
// 运行：cd backend && node src/langgraph/manual-tests/scenario2-incidental.js
const { graph } = require('../graph');
const { createInitialSlots } = require('../state');

function makeInitialState() {
  const slots = createInitialSlots();
  slots.scene = { value: '外卖', confirmed: true };
  return {
    messages: [],
    slots,
    candidateSlots: {},
    // 这一轮AI实际问的是忌口，不是场景
    lastAskedSlot: 'restrictions',
    pendingConfirmation: null,
    retrieved: [],
  };
}

async function main() {
  let state = makeInitialState();

  console.log('=== 初始状态 ===');
  console.log('slots.scene:', JSON.stringify(state.slots.scene));

  console.log('\n=== 用户回答忌口问题时，顺嘴提到"食堂"这个词 ===');
  state = await graph.invoke({
    ...state,
    messages: [
      ...state.messages,
      { role: 'human', content: '我们食堂辣的东西我都不太能吃，容易反胃' },
    ],
  });

  console.log('slots.scene:', JSON.stringify(state.slots.scene));
  console.log('slots.restrictions:', JSON.stringify(state.slots.restrictions));
  console.log('pendingConfirmation:', JSON.stringify(state.pendingConfirmation));

  console.log('\n--- 预期：slots.scene 应该还是 {value:"外卖",confirmed:true}（没被误触发确认），');
  console.log('    slots.restrictions 应该被正常更新成跟"辣/反胃"相关的内容，');
  console.log('    pendingConfirmation 应该是 null ---');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
