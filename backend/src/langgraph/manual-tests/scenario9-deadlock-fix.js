// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 复现测试：Bug 2（死锁）修复验证。
//
// 直接构造"已经有一个待确认事项"的状态（不依赖某个具体触发词，绕开
// Bug 1 是否修复这个变量，专门测死锁本身的修复），然后模拟用户连续
// 给出好几项新信息、但不直接回应那个确认问题，检查这些新信息有没有
// 被正常抽取、记录下来，而不是被无声吞掉。
//
// 用三种不同的"待确认上下文"分别测一遍，确认修复是稳定的，不是只
// 堵住了某一种具体场景。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario9-deadlock-fix.js
const { graph } = require('../graph');
const { createInitialSlots } = require('../state');

async function runCase(caseName, { pendingConfirmation, initialSlots, turns }) {
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

  for (let i = 0; i < turns.length; i += 1) {
    const message = turns[i];
    console.log(`\n--- 第${i + 1}轮，用户说"${message}"（不直接回应确认问题） ---`);

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
    console.log('pendingConfirmation 是否仍存在:', state.pendingConfirmation ? '是（预期如此，旧确认还没解决）' : '否');
    const lastMsg = state.messages[state.messages.length - 1];
    console.log('AI回复:', lastMsg.role === 'human' ? '(本轮没有生成新回复)' : lastMsg.content);
  }

  return state;
}

async function main() {
  // 场景1：待确认的是"场景"（食堂 vs 外卖），用户随后给出预算信息
  const slots1 = createInitialSlots();
  slots1.scene = { value: '食堂', confirmed: true };
  const state1 = await runCase('场景1：待确认scene，用户后续说预算', {
    pendingConfirmation: { field: 'scene', oldValue: '食堂', newValue: '外卖' },
    initialSlots: slots1,
    turns: ['一顿大概20块吧'],
  });
  console.log('\n>>> 场景1检查：budget 有没有被正确记录:', JSON.stringify(state1.slots.budget));

  // 场景2：待确认的是"身材目标"，用户连续两轮分别说忌口、运动
  const slots2 = createInitialSlots();
  slots2.scene = { value: '食堂', confirmed: true };
  slots2.goal = { value: '穿衣更好看', confirmed: true };
  const state2 = await runCase('场景2：待确认goal，用户连续两轮说忌口+运动', {
    pendingConfirmation: { field: 'goal', oldValue: '穿衣更好看', newValue: '拍照更立体' },
    initialSlots: slots2,
    turns: ['不吃香菜', '平时不怎么运动'],
  });
  console.log(
    '\n>>> 场景2检查：restrictions/exercise 有没有被正确记录:',
    JSON.stringify(state2.slots.restrictions),
    JSON.stringify(state2.slots.exercise)
  );

  // 场景3：待确认的是"口味"，用户一句话里同时给出预算+忌口两项新信息
  const slots3 = createInitialSlots();
  slots3.scene = { value: '外卖', confirmed: true };
  slots3.taste = { value: '喜欢辣', confirmed: true };
  const state3 = await runCase('场景3：待确认taste，用户一句话给两项新信息', {
    pendingConfirmation: { field: 'taste', oldValue: '喜欢辣', newValue: '喜欢清淡' },
    initialSlots: slots3,
    turns: ['预算15块左右，然后不吃牛肉'],
  });
  console.log(
    '\n>>> 场景3检查：budget/restrictions 有没有被正确记录:',
    JSON.stringify(state3.slots.budget),
    JSON.stringify(state3.slots.restrictions)
  );

  console.log('\n\n=== 总结：三种场景下，新信息应该都被正确记录（不是null），且 pendingConfirmation 应该全程保持非空（旧确认还没被这些新信息顶替解决） ===');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
