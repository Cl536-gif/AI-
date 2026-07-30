// 手动测试脚本（需要真实起服务、真实网络访问 DashScope，云端沙箱
// 环境跑不了）。延续标准9轮测试暴露的情况：用户打乱顺序提前给信息时，
// restrictions/goal/exercise 这几项会因为 lastAskedSlot 一直冻结在
// "预算"上，需要经过几轮确认/放弃循环才能逐个落地，9轮标准测试跑完时
// 它们还是空的。
//
// 这个测试专门验证："虽然慢，但最终一定能补上"这件事是不是真的——
// 不是理论推导，是真的把对话继续跑下去，看 restrictions/goal/exercise
// 最终会不会全部被正常确认，isComplete 最终会不会变成 true，而不是
// 永远卡在部分字段确认不了的状态。
//
// 运行前先在另一个终端起服务：
//   cd backend && LANGGRAPH_DEBUG=1 npm start
// 然后：
//   cd backend && node src/langgraph/manual-tests/scenario13-eventual-completion.js
const BASE_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';

const INITIAL_TURNS = ['你好', '靠谱吗', '食堂', '自选', '偏辣', '不吃香菜', '20元左右', '穿衣更好看', '不运动'];

// 标准9轮结束时，restrictions/goal/exercise 大概率还有部分没落地，
// 且可能有一个待确认事项卡着。后续这些回合模拟一个"正常配合"的用户：
// 不管AI这一轮问的是确认问题还是新问题，都直接、正面地回应——"对，
// 没错"用来应对任意可能出现的确认问题，三句真实内容用来在AI终于问到
// 对应字段时给出答案。轮次故意留够余量（不追求最少轮数），只关心
// "最终能不能完成"，不关心"要花几轮"。
const FOLLOWUP_TURNS = ['对，没错', '不吃香菜', '对，没错', '穿衣更好看', '对，没错', '不运动', '对，没错', '对，没错'];

const MAX_TURNS_BEFORE_GIVING_UP = INITIAL_TURNS.length + FOLLOWUP_TURNS.length;

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
  const allTurns = [...INITIAL_TURNS, ...FOLLOWUP_TURNS];
  let completedAtTurn = null;
  let lastData = null;

  for (let i = 0; i < allTurns.length; i += 1) {
    const message = allTurns[i];
    console.log(`\n========== 第${i + 1}轮：用户说"${message}" ==========`);

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
      // isComplete变true这一轮触发的是askServiceChoice（问免费问答还是
      // 付费定期推送），不是直接触发generatePlan——真正出方案要等用户
      // 回答这个分岔之后，这个脚本只关心六项能不能收敛，不延伸测服务
      // 分岔，那部分见 scenario17-service-choice.js。
      console.log(`\n>>> 六项信息在第${completedAtTurn}轮全部确认完毕，触发了 askServiceChoice`);
      break;
    }
  }

  console.log('\n\n=== 核对 ===');
  if (completedAtTurn !== null) {
    console.log(`✅ 六项最终都被正常确认了，在第${completedAtTurn}轮完成（总共给了${MAX_TURNS_BEFORE_GIVING_UP}轮的余量），说明"打乱顺序提前给信息"这个代价只是变慢，不是永久卡住。`);
  } else {
    console.log(`❌ 跑完全部${allTurns.length}轮，isComplete仍然是false，六项状态: ${JSON.stringify(lastData && lastData.slots)}`);
    console.log('❌ 这说明存在某个字段可能被无限期搁置的风险，不是单纯的体验代价，需要作为新的隐性死锁立刻处理。');
  }
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
