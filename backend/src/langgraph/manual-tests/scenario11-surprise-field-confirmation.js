// 结构性安全防线验证：conflictRouter 里"意外字段（非lastAskedSlot）
// 首次出现候选值时，不能无脑自动确认"这条规则，是纯代码逻辑，不依赖
// 模型判断——所以这个测试直接构造 candidateSlots，模拟"extractSlots
// 编造/误判出候选值"这件事本身，不需要真的让模型输出错误内容，也不
// 需要网络访问，可以在任何环境跑（包括没有 DashScope 网络权限的沙箱）。
//
// 故意用两个全新的、之前没测过的"意外字段"组合（不是"自选"），验证
// 这道防线堵住的是"这一类问题"（任何意外字段的首次候选值都不能绕过
// 确认），不是"自选"这一个具体案例。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario11-surprise-field-confirmation.js
const { conflictRouter } = require('../nodes/conflictRouter');
const { createInitialSlots } = require('../state');

async function runCase(caseName, { lastAskedSlot, initialSlots, candidateSlots, expectAutoConfirmed, expectPendingField }) {
  console.log(`\n########## ${caseName} ##########`);
  console.log('lastAskedSlot:', lastAskedSlot);
  console.log('candidateSlots:', JSON.stringify(candidateSlots));

  const result = await conflictRouter({
    messages: [],
    slots: initialSlots,
    candidateSlots,
    lastAskedSlot,
    pendingConfirmation: null,
  });

  console.log('conflictRouter 返回的 slots 更新:', JSON.stringify(result.slots));
  console.log('conflictRouter 返回的 pendingConfirmation:', JSON.stringify(result.pendingConfirmation ?? null));

  let ok = true;

  // 检查：本该自动确认的focus字段，确实自动确认了
  expectAutoConfirmed.forEach((key) => {
    const updated = result.slots[key];
    if (!updated || updated.confirmed !== true) {
      console.log(`❌ 期望 ${key} 被自动确认，但实际是: ${JSON.stringify(updated)}`);
      ok = false;
    } else {
      console.log(`✅ ${key} 按预期自动确认（focus字段，风险较低）`);
    }
  });

  // 核心检查：意外字段绝对不能出现在自动确认的 slots 更新里
  Object.keys(candidateSlots).forEach((key) => {
    if (expectAutoConfirmed.includes(key)) return;
    if (result.slots[key] && result.slots[key].confirmed === true) {
      console.log(`❌❌❌ 安全漏洞复现！意外字段 ${key} 被无脑自动确认了: ${JSON.stringify(result.slots[key])}`);
      ok = false;
    } else {
      console.log(`✅ 意外字段 ${key} 没有被自动确认（没有出现在自动确认的slots更新里）`);
    }
  });

  // 检查：应该恰好产生一个待确认事项，指向预期字段，oldValue为null
  if (!result.pendingConfirmation) {
    console.log(`❌ 期望产生 pendingConfirmation（field=${expectPendingField}），但实际没有`);
    ok = false;
  } else if (result.pendingConfirmation.field !== expectPendingField) {
    console.log(`❌ pendingConfirmation.field 期望是 ${expectPendingField}，实际是 ${result.pendingConfirmation.field}`);
    ok = false;
  } else if (result.pendingConfirmation.oldValue !== null) {
    console.log(`❌ pendingConfirmation.oldValue 期望是 null（表示不是真的"改口"），实际是 ${JSON.stringify(result.pendingConfirmation.oldValue)}`);
    ok = false;
  } else {
    console.log(`✅ 正确产生了 pendingConfirmation，指向 ${expectPendingField}，oldValue=null`);
  }

  console.log(ok ? `\n>>> ${caseName}：通过` : `\n>>> ${caseName}：未通过`);
  return ok;
}

async function main() {
  // 案例1：用户在回答"口味"问题（lastAskedSlot=taste），但candidateSlots
  // 里同时冒出了goal和exercise两个完全没被问过的意外字段——模拟一种
  // 全新的、跟"自选"无关的编造模式。scene已经确认过（食堂），taste/
  // budget/restrictions/goal/exercise都还没确认过。
  const slots1 = createInitialSlots();
  slots1.scene = { value: '食堂', confirmed: true };
  const ok1 = await runCase('案例1：回答口味时，意外冒出goal+exercise两个候选值', {
    lastAskedSlot: 'taste',
    initialSlots: slots1,
    candidateSlots: { taste: '清淡为主', goal: '减脂', exercise: '每周三次' },
    expectAutoConfirmed: ['taste'],
    // SLOT_KEYS顺序里goal在exercise前面，预期goal被选为pendingConfirmation，
    // exercise本轮应该被丢弃（避免同时堆叠两个待确认）
    expectPendingField: 'goal',
  });

  // 案例2：用户在回答"是否运动"问题（lastAskedSlot=exercise），但
  // candidateSlots里意外冒出了scene——模拟另一种全新的编造模式，这次
  // 意外字段排在SLOT_KEYS更靠前的位置，确认防线不是靠字段顺序凑巧生效的。
  const slots2 = createInitialSlots();
  slots2.taste = { value: '偏辣', confirmed: true };
  slots2.budget = { value: '20元左右', confirmed: true };
  slots2.restrictions = { value: '不吃香菜', confirmed: true };
  slots2.goal = { value: '穿衣更好看', confirmed: true };
  const ok2 = await runCase('案例2：回答是否运动时，意外冒出scene候选值', {
    lastAskedSlot: 'exercise',
    initialSlots: slots2,
    candidateSlots: { exercise: '不运动', scene: '外卖' },
    expectAutoConfirmed: ['exercise'],
    expectPendingField: 'scene',
  });

  console.log('\n\n=== 总结 ===');
  console.log(ok1 && ok2 ? '两个全新场景都通过，结构性防线对未预判过的编造模式同样有效。' : '有场景未通过，结构性防线没有完全生效，需要继续排查。');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
