// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 复现测试：标准9轮真实测试暴露的新问题——一个待确认事项如果用户一直
// 不正面回应、只是继续正常回答别的问题，会无限期卡住整个流程，AI原地
// 重复同一句确认问题，后续所有"意外字段"都被反复丢弃，表现跟死锁
// 几乎一样。
//
// 修复后预期：确认问题最多问 MAX_ASK_COUNT(=2) 次，如果一直没能得到
// 明确回应，就自动放弃这次确认（恢复原状），把主动权还给对话，让用户
// 后续正常给出的信息能继续被处理，而不是永远卡在原地重复同一句问题。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario12-stale-confirmation-giveup.js
const { graph } = require('../graph');
const { createInitialSlots } = require('../state');

async function main() {
  console.log('########## 场景：待确认restrictions，用户连续3轮都不正面回应，只是继续正常答别的问题 ##########');

  const slots = createInitialSlots();
  slots.scene = { value: '食堂', confirmed: true };
  slots.taste = { value: '偏辣', confirmed: true };

  let state = {
    messages: [],
    slots,
    candidateSlots: {},
    lastAskedSlot: 'budget',
    pendingConfirmation: { field: 'restrictions', oldValue: null, newValue: '不吃香菜' },
    retrieved: [],
  };

  const turns = ['20元左右', '穿衣更好看', '不运动'];
  // 第1轮：20元左右，正好是lastAskedSlot(budget)，应该被正常自动确认，
  //        同时因为restrictions这个待确认还没解决，AI回复预期还是在
  //        问restrictions（这一轮属于"问过第1次"）。
  // 第2轮：穿衣更好看，不是lastAskedSlot也不是待确认字段本身，属于
  //        "意外字段"，这时候pendingConfirmation.askedCount应该已经是1
  //        （上一轮问过一次），这次unclear之后变成2，还没到放弃阈值，
  //        goal预期继续被丢弃，restrictions这次是"问过第2次"。
  // 第3轮：不运动，这次resolvePendingConfirmation应该发现已经问了2次
  //        还是不清楚，自动放弃restrictions这个确认（恢复成未确认），
  //        然后这一轮的"不运动"应该被正常处理（走到extractSlots+
  //        conflictRouter，因为此时已经没有pendingConfirmation卡着了）。

  for (let i = 0; i < turns.length; i += 1) {
    const message = turns[i];
    console.log(`\n--- 第${i + 1}轮，用户说"${message}" ---`);
    // eslint-disable-next-line no-await-in-loop
    state = await graph.invoke({
      ...state,
      messages: [...state.messages, { role: 'human', content: message }],
    });

    console.log(
      '六项状态:',
      Object.entries(state.slots)
        .map(([k, v]) => `${k}=${v.value ?? '(空)'}${v.confirmed ? '✓' : ''}`)
        .join(' | ')
    );
    console.log('pendingConfirmation:', JSON.stringify(state.pendingConfirmation ?? null));
    const lastMsg = state.messages[state.messages.length - 1];
    console.log('AI回复:', lastMsg.role === 'human' ? '(本轮没有生成新回复)' : lastMsg.content);
  }

  console.log('\n\n=== 核对 ===');
  let ok = true;

  // 注意：放弃restrictions这个确认之后，第3轮"不运动"因为不是
  // lastAskedSlot，会按设计正常进入它自己新的确认流程（exercise的
  // pendingConfirmation）——这是正确行为，不代表又卡住了。真正要检查
  // 的是：pendingConfirmation不能还停留在旧的restrictions上（那才是
  // 卡住），如果是一个新的、field不同、askedCount很低的待确认，说明
  // 流程已经恢复正常、重新开始了一轮新的确认周期。
  if (state.pendingConfirmation && state.pendingConfirmation.field === 'restrictions') {
    console.log(`❌ 期望旧的restrictions确认已经被放弃，但实际还停留在它上面: ${JSON.stringify(state.pendingConfirmation)}`);
    ok = false;
  } else if (state.pendingConfirmation) {
    console.log(`✅ restrictions确认已放弃，当前是一个全新的待确认事项（${state.pendingConfirmation.field}，askedCount=${state.pendingConfirmation.askedCount}），流程恢复正常，不是卡在原地`);
  } else {
    console.log('✅ 3轮之后 pendingConfirmation 已经被自动放弃清空，没有无限期卡住');
  }

  if (!state.slots.budget || !state.slots.budget.confirmed) {
    console.log(`❌ 期望 budget 在第1轮就被正常记录，但实际是: ${JSON.stringify(state.slots.budget)}`);
    ok = false;
  } else {
    console.log(`✅ budget 正常记录: ${JSON.stringify(state.slots.budget)}`);
  }

  if (state.slots.restrictions && state.slots.restrictions.confirmed) {
    console.log(`❌ 期望放弃确认之后 restrictions 恢复成未确认状态（等用户之后正常被问到或重提），但实际是: ${JSON.stringify(state.slots.restrictions)}`);
    ok = false;
  } else {
    console.log(`✅ restrictions 放弃确认后正确恢复成未确认状态: ${JSON.stringify(state.slots.restrictions)}`);
  }

  console.log(ok ? '\n>>> 通过：确认问题不会无限期卡住流程' : '\n>>> 未通过：仍然存在无限期卡住的风险');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
