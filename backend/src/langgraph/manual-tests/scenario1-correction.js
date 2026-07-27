// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 场景1：正常改口——已确认场景是"外卖"，几轮后用户改口说"食堂"，
// 应该触发 askConfirmation 走确认流程，不直接覆盖旧值；用户确认后，
// 状态才真正更新成"食堂"。
//
// 运行：cd backend && node src/langgraph/manual-tests/scenario1-correction.js
const { graph } = require('../graph');
const { createInitialSlots } = require('../state');

function makeInitialState() {
  const slots = createInitialSlots();
  slots.scene = { value: '外卖', confirmed: true };
  return {
    messages: [],
    slots,
    candidateSlots: {},
    // 模拟"几轮后"：假设上一轮AI正在问口味，不是在问场景
    lastAskedSlot: 'taste',
    pendingConfirmation: null,
    retrieved: [],
  };
}

async function main() {
  let state = makeInitialState();

  console.log('=== 初始状态 ===');
  console.log('slots.scene:', JSON.stringify(state.slots.scene));

  console.log('\n=== 第1轮：用户改口说食堂 ===');
  state = await graph.invoke({
    ...state,
    messages: [...state.messages, { role: 'human', content: '哦对了，我其实是在食堂吃，不是点外卖' }],
  });
  console.log('slots.scene:', JSON.stringify(state.slots.scene));
  console.log('pendingConfirmation:', JSON.stringify(state.pendingConfirmation));
  const lastMsg = state.messages[state.messages.length - 1];
  const lastMsgIsAi = lastMsg && lastMsg.role !== 'human';
  console.log('AI回复:', lastMsgIsAi ? lastMsg.content : '(本轮没有生成新的AI回复——最后一条消息还是用户自己那句话)');

  console.log('\n--- 预期：slots.scene 应该还是 {value:"外卖",confirmed:true}（没被直接覆盖），');
  console.log('    pendingConfirmation 应该非空（field=scene），AI回复应该是一句确认问句 ---');

  console.log('\n=== 第2轮：用户确认改动 ===');
  state = await graph.invoke({
    ...state,
    messages: [...state.messages, { role: 'human', content: '对，改成食堂' }],
  });
  console.log('slots.scene:', JSON.stringify(state.slots.scene));
  console.log('pendingConfirmation:', JSON.stringify(state.pendingConfirmation));

  console.log('\n--- 预期：slots.scene 应该变成 {value:"食堂",confirmed:true}，pendingConfirmation 应该是 null ---');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
