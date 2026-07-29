// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 背景：诊断"你好"开场白偶尔被not_asking_target_slot误判的根因时，
// 发现 extractSlots、conflictRouter、resolvePendingConfirmation、
// checkAsksTargetSlot 这四个"分类型判断"节点，之前全部复用跟"生成
// 自然对话回复"同一个 temperature:0.7 的model实例——这是结构性问题，
// 不只影响撞见过bug的两处（extractSlots的孤立数字判断、
// checkAsksTargetSlot的首轮开场白判断），conflictRouter（改口判断）
// 和 resolvePendingConfirmation（待确认解析）理论上有同样的风险
// 敞口，只是还没真的撞见过具体案例。
//
// 四个节点已经统一切换成低temperature的classifierModel。这个脚本
// 专门补测之前没撞见过问题的两个节点，各用一个最容易出错、判断边界
// 最需要稳定的场景连续跑5次，确认切换temperature之后没有引入新的
// 不稳定。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario15-classifier-temperature-repeat-check.js
const { classifyPotentialConflict } = require('../nodes/conflictRouter');
const { resolvePendingConfirmation } = require('../nodes/resolvePendingConfirmation');

async function runConflictRouterCase(round) {
  // 典型的"改口"场景：用户带着"哦对了""其实是"这类自我修正语气，
  // 明确否定此前确认的旧值——应该稳定判成 correction，不能判成
  // same_meaning 或 incidental_mention。
  const { classification, reason } = await classifyPotentialConflict({
    slotLabel: '就餐场景（食堂/外卖）',
    oldValue: '外卖',
    newValue: '食堂',
    focusLabel: '口味偏好',
    userText: '哦对了，我其实是在食堂吃，不是点外卖',
  });

  const ok = classification === 'correction';
  console.log(`第${round}次 -> classification: ${classification}（理由: ${reason}）`);
  console.log(ok ? '✅ 正确判成correction' : `❌ 判成了${classification}（复现了不稳定）`);
  return ok;
}

async function runResolvePendingConfirmationCase(round) {
  // 典型的"确认改口"场景：用户明确回应"对，改成X"，应该稳定判成
  // confirmed，新值真正落地、pendingConfirmation清空。
  const result = await resolvePendingConfirmation({
    messages: [{ role: 'human', content: '对，改成食堂' }],
    pendingConfirmation: { field: 'scene', oldValue: '外卖', newValue: '食堂', askedCount: 1 },
  });

  const ok =
    result.slots &&
    result.slots.scene &&
    result.slots.scene.value === '食堂' &&
    result.slots.scene.confirmed === true &&
    result.pendingConfirmation === null;

  console.log(`第${round}次 -> 返回结果:`, JSON.stringify(result));
  console.log(ok ? '✅ 正确判成confirmed，新值正常落地' : '❌ 没有正确落地（复现了不稳定）');
  return ok;
}

async function main() {
  console.log('########## conflictRouter：改口判断场景，连续跑5次 ##########');
  const conflictResults = [];
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    conflictResults.push(await runConflictRouterCase(i));
  }
  const conflictPass = conflictResults.filter(Boolean).length;
  console.log(`\n=== conflictRouter总结：5次里有 ${conflictPass} 次正确判成correction ===\n`);

  console.log('########## resolvePendingConfirmation：确认解析场景，连续跑5次 ##########');
  const resolveResults = [];
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    resolveResults.push(await runResolvePendingConfirmationCase(i));
  }
  const resolvePass = resolveResults.filter(Boolean).length;
  console.log(`\n=== resolvePendingConfirmation总结：5次里有 ${resolvePass} 次正确落地 ===\n`);

  console.log('=== 整体结论 ===');
  console.log(
    conflictPass === 5 && resolvePass === 5
      ? '两个节点都5/5稳定通过，切换低temperature没有引入新的不稳定。'
      : '存在不稳定的情况，需要针对性看是哪个节点、哪次跑出了不一样的结果。'
  );
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
