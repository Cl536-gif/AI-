// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 复现测试：Bug 2（死锁）修复验证 + 结构性安全防线（意外字段首次填充
// 必须走确认流程）落地后，对这个场景的预期更新。
//
// 重要：这个测试的预期在"意外字段结构性防线"上线后发生了变化，请不要
// 把这次的"本轮丢弃"误认为死锁又复发了——两者是完全不同的性质：
//   - Bug 2（死锁，已修复）：AI 永久卡住，之后所有轮次都无法前进，
//     新信息被无声吞掉、再也没有机会被记录。
//   - 这次的"本轮丢弃"（新防线带来的预期变化，是设计好的行为，不是
//     bug）：已经有一个待确认事项（pendingConfirmation）时，用户提到的
//     "意外字段"（既不是AI当前问的字段，也不是那个待确认事项本身）
//     这一轮不会被记录，但不是永久丢失——旧的待确认事项一旦被解决，
//     用户下一轮重新提起，就能被正常抽取和确认。这是延续了"不叠加
//     第二个待确认事项"这条原有规则（避免用户同时面对两个待澄清的
//     问题），不是让 extractSlots/conflictRouter 又开始无脑吞掉信息。
//
// 这个文件因此测两件事：
//   A. 有旧的待确认事项时，意外字段新信息这一轮确实是"温和丢弃"——
//      不是被自动确认（这是之前"自选"漏洞的机制），也不是让状态出现
//      任何奇怪的残留，就是这一轮单纯不记录。
//   B. 解决掉旧的待确认事项之后，用户重新提起同样的信息，必须能被
//      正常记录（自动确认，或者进入新的待确认流程都算正常——只要
//      不是又一次"什么都没发生"），且不会因为"上一轮被丢弃过"而
//      留下任何影响这一轮正常处理的残留状态。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario9-deadlock-fix.js
const { graph } = require('../graph');
const { createInitialSlots } = require('../state');

function printState(label, state) {
  console.log(
    `${label} 六项状态:`,
    Object.entries(state.slots)
      .map(([k, v]) => `${k}=${v.value ?? '(空)'}${v.confirmed ? '✓' : ''}`)
      .join(' | ')
  );
  console.log(`${label} pendingConfirmation:`, JSON.stringify(state.pendingConfirmation ?? null));
  const lastMsg = state.messages[state.messages.length - 1];
  console.log(`${label} AI回复:`, lastMsg.role === 'human' ? '(本轮没有生成新回复)' : lastMsg.content);
}

async function sendTurn(state, message) {
  return graph.invoke({
    ...state,
    messages: [...state.messages, { role: 'human', content: message }],
  });
}

async function runCase({
  caseName,
  pendingConfirmation,
  initialSlots,
  dropTurns, // 待确认还没解决时，用户提到的意外字段信息（预期：本轮丢弃）
  droppedFields, // dropTurns 对应期望被丢弃、这一步不应该出现变化的字段
  resolveTurn, // 用来解决旧待确认事项的用户回复
  expectResolvedField, // 旧待确认事项对应的字段（用来检查它最终确实有了确定的状态）
  reproTurns, // 解决完旧待确认之后，重新提起同样信息的用户回复（跟dropTurns一一对应）
  reproFields, // reproTurns 对应、期望这次能被正常记录的字段
}) {
  console.log(`\n########## ${caseName} ##########`);

  let state = {
    messages: [],
    slots: initialSlots,
    candidateSlots: {},
    lastAskedSlot: null,
    pendingConfirmation,
    retrieved: [],
  };
  console.log('初始 pendingConfirmation:', JSON.stringify(state.pendingConfirmation));

  let stepOk = true;

  // 阶段A：旧确认还没解决时，意外字段新信息应该"本轮丢弃"
  for (let i = 0; i < dropTurns.length; i += 1) {
    const message = dropTurns[i];
    const field = droppedFields[i];
    const beforeSlot = JSON.stringify(state.slots[field]);

    console.log(`\n--- [阶段A] 第${i + 1}轮，用户说"${message}"（不直接回应确认问题） ---`);
    // eslint-disable-next-line no-await-in-loop
    state = await sendTurn(state, message);
    printState('[阶段A]', state);

    const afterSlot = JSON.stringify(state.slots[field]);
    if (afterSlot !== beforeSlot) {
      console.log(`❌ 期望 ${field} 这一轮保持不变（应该被丢弃），但实际从 ${beforeSlot} 变成了 ${afterSlot}`);
      stepOk = false;
    } else if (state.slots[field].confirmed) {
      console.log(`❌❌ 更严重：${field} 已经是confirmed状态，说明是之前初始状态就confirmed，测试用例设计有误`);
      stepOk = false;
    } else {
      console.log(`✅ ${field} 这一轮按预期保持不变（本轮丢弃，不是自动确认，也没有异常残留）`);
    }

    if (!state.pendingConfirmation || state.pendingConfirmation.field !== pendingConfirmation.field) {
      console.log(`❌ 期望旧的待确认事项（${pendingConfirmation.field}）保持不变，但实际变了: ${JSON.stringify(state.pendingConfirmation)}`);
      stepOk = false;
    } else {
      console.log(`✅ 旧的待确认事项（${pendingConfirmation.field}）保持不变，没有被意外字段顶替或叠加`);
    }
  }

  // 阶段B：解决掉旧的待确认事项
  console.log(`\n--- [阶段B] 用户回应旧的确认问题："${resolveTurn}" ---`);
  state = await sendTurn(state, resolveTurn);
  printState('[阶段B]', state);

  if (state.pendingConfirmation) {
    console.log(`❌ 期望旧的待确认事项（${expectResolvedField}）在这一轮之后被解决（清空），但实际仍是: ${JSON.stringify(state.pendingConfirmation)}`);
    stepOk = false;
  } else {
    console.log(`✅ 旧的待确认事项（${expectResolvedField}）已解决，pendingConfirmation 已清空`);
  }

  // 阶段C：重新提起之前被丢弃的信息，必须能被正常记录（不能再是"什么都没发生"）
  for (let i = 0; i < reproTurns.length; i += 1) {
    const message = reproTurns[i];
    const field = reproFields[i];
    const beforeSlot = JSON.stringify(state.slots[field]);

    console.log(`\n--- [阶段C] 第${i + 1}轮，重新提起："${message}" ---`);
    // eslint-disable-next-line no-await-in-loop
    state = await sendTurn(state, message);
    printState('[阶段C]', state);

    const afterSlot = JSON.stringify(state.slots[field]);
    const gotConfirmed = state.slots[field] && state.slots[field].confirmed;
    const gotQueuedForConfirmation = state.pendingConfirmation && state.pendingConfirmation.field === field;

    if (afterSlot === beforeSlot && !gotQueuedForConfirmation) {
      console.log(`❌ 期望重新提起后 ${field} 要么被确认、要么进入新的待确认流程，但实际什么都没发生（又一次被无声丢弃，说明有残留状态在干扰）`);
      stepOk = false;
    } else if (gotConfirmed) {
      console.log(`✅ ${field} 这次被正常自动确认了: ${afterSlot}`);
    } else if (gotQueuedForConfirmation) {
      console.log(`✅ ${field} 这次正常进入了新的待确认流程（不是自动确认，但也不是被丢弃）: ${JSON.stringify(state.pendingConfirmation)}`);
    }
  }

  console.log(stepOk ? `\n>>> ${caseName}：通过` : `\n>>> ${caseName}：未通过`);
  return stepOk;
}

async function main() {
  const results = [];

  // 场景1：待确认的是"场景"（食堂 vs 外卖），用户随后说预算（意外字段）
  const slots1 = createInitialSlots();
  slots1.scene = { value: '食堂', confirmed: true };
  results.push(
    await runCase({
      caseName: '场景1：待确认scene，用户说预算（意外字段，应本轮丢弃），解决后重提',
      pendingConfirmation: { field: 'scene', oldValue: '食堂', newValue: '外卖' },
      initialSlots: slots1,
      dropTurns: ['一顿大概20块吧'],
      droppedFields: ['budget'],
      resolveTurn: '不是，还是食堂',
      expectResolvedField: 'scene',
      reproTurns: ['预算大概20块左右'],
      reproFields: ['budget'],
    })
  );

  // 场景2：待确认的是"身材目标"，用户连续两轮分别说忌口、运动（都是意外字段）
  const slots2 = createInitialSlots();
  slots2.scene = { value: '食堂', confirmed: true };
  slots2.goal = { value: '穿衣更好看', confirmed: true };
  results.push(
    await runCase({
      caseName: '场景2：待确认goal，用户连续两轮说忌口+运动，解决后重提',
      pendingConfirmation: { field: 'goal', oldValue: '穿衣更好看', newValue: '拍照更立体' },
      initialSlots: slots2,
      dropTurns: ['不吃香菜', '平时不怎么运动'],
      droppedFields: ['restrictions', 'exercise'],
      resolveTurn: '不用改，还是穿衣更好看这个目标',
      expectResolvedField: 'goal',
      reproTurns: ['不吃香菜', '平时不怎么运动'],
      reproFields: ['restrictions', 'exercise'],
    })
  );

  // 场景3：待确认的是"口味"，用户一句话里同时给出预算+忌口两项意外字段
  const slots3 = createInitialSlots();
  slots3.scene = { value: '外卖', confirmed: true };
  slots3.taste = { value: '喜欢辣', confirmed: true };
  results.push(
    await runCase({
      caseName: '场景3：待确认taste，用户一句话给两项意外字段，解决后重提',
      pendingConfirmation: { field: 'taste', oldValue: '喜欢辣', newValue: '喜欢清淡' },
      initialSlots: slots3,
      dropTurns: ['预算15块左右，然后不吃牛肉'],
      droppedFields: ['budget'],
      resolveTurn: '对，我现在改成喜欢清淡口味了',
      expectResolvedField: 'taste',
      reproTurns: ['预算15块左右，然后不吃牛肉'],
      reproFields: ['budget'],
    })
  );

  const passCount = results.filter(Boolean).length;
  console.log(`\n\n=== 总结：${results.length}个场景里有 ${passCount} 个通过 ===`);
  console.log('每个场景验证两件事：A) 旧确认未解决时，意外字段新信息本轮温和丢弃，不出现自动确认或状态错乱；');
  console.log('B) 旧确认解决后，重新提起同样信息，能被正常记录（自动确认或进入新的待确认流程），不会因为上一轮丢弃过而卡住。');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
