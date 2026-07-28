// 手动测试脚本（需要真实起服务、真实网络访问 DashScope，云端沙箱
// 环境跑不了）。压力测试：askNextQuestion 的"提前出方案"矛盾检测，
// 在明显更长的对话历史（20轮以上）下是否依然稳定拦截，而不是只在
// 之前撞见问题的那个长度（10-15轮）下有效。
//
// 做法：在标准9轮 + 触发死锁/确认循环的基础上，故意插入一批不影响
// 六项状态的闲聊/跑题内容，把对话长度撑到20轮以上，同时每一轮
// （只要还没收集完）都会重新调用 askNextQuestion，反复给这道检测
// 制造被撞见的机会；最后再用几轮"正常配合"的真实回答收尾，确认最终
// 依然能正常走到 generatePlan。
//
// 运行前先在另一个终端起服务：
//   cd backend && LANGGRAPH_DEBUG=1 npm start
// 然后：
//   cd backend && node src/langgraph/manual-tests/scenario14-long-conversation-premature-plan.js
const BASE_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';

const TURNS = [
  // 标准开场 + 触发确认循环（跟scenario7/13一致）
  '你好',
  '靠谱吗',
  '食堂',
  '自选',
  '偏辣',
  '不吃香菜',
  '20元左右',
  '穿衣更好看',
  '不运动',
  // 大量闲聊/跑题，撑长对话历史，同时每轮都会重新触发askNextQuestion
  // （因为六项还没收集完），反复给"提前出方案"矛盾检测制造被撞见的机会
  '你是机器人吗',
  '哈哈挺好玩的',
  '我有点饿了',
  '今天天气不错',
  '你还会干嘛',
  '随便聊聊',
  '我在宿舍呢',
  '等会儿要去上课',
  '你说话挺自然的',
  '继续吧',
  // 最后用"正常配合"的真实回答收尾，确认最终能正常走完
  '对，没错',
  '不吃香菜',
  '对，没错',
  '穿衣更好看',
  '对，没错',
  '不运动',
  '对，没错',
  '对，没错',
];

let threadId;

async function sendTurn(message) {
  const body = { message };
  if (threadId) body.threadId = threadId;

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

  threadId = data.threadId;
  return data;
}

async function main() {
  let completedAtTurn = null;
  let lastData = null;

  for (let i = 0; i < TURNS.length; i += 1) {
    const message = TURNS[i];
    console.log(`\n========== 第${i + 1}轮（对话历史已有${i}条用户消息）：用户说"${message}" ==========`);

    // eslint-disable-next-line no-await-in-loop
    const data = await sendTurn(message);
    lastData = data;

    console.log('AI回复:', data.reply);
    console.log('isComplete:', data.isComplete);
    console.log(
      '六项状态:',
      Object.entries(data.slots || {})
        .map(([k, v]) => `${k}=${v.value ?? '(空)'}${v.confirmed ? '✓' : ''}`)
        .join(' | ')
    );

    if (data.isComplete && completedAtTurn === null) {
      completedAtTurn = i + 1;
      console.log(`\n>>> 六项信息在第${completedAtTurn}轮全部确认完毕，触发了 generatePlan`);
      break;
    }
  }

  console.log('\n\n=== 核对 ===');
  console.log('请重点看终端A（服务端）的 [askNextQuestion] 调试日志：');
  console.log('1. 有没有出现"命中\'提前出方案\'矛盾"的情况——如果出现了，说明在长对话下模型确实还是会尝试提前出方案；');
  console.log('2. 如果出现了，紧接着的下一次生成有没有变成"没有提前出方案矛盾"——这才是重点，说明重试机制成功拦截、修正了这次矛盾，不是任由它漏过去。');
  console.log('3. 全程六项状态里，有没有任何一轮isComplete=false的情况下，AI回复却出现完整的具体菜品方案——这是最终必须避免的结果。');

  if (completedAtTurn !== null) {
    console.log(`\n✅ 六项最终在第${completedAtTurn}轮（对话历史已经相当长）正常完成，说明防线在长对话下依然有效。`);
  } else {
    console.log(`\n❌ 跑完全部${TURNS.length}轮，isComplete仍然是false，六项状态: ${JSON.stringify(lastData && lastData.slots)}`);
  }
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
