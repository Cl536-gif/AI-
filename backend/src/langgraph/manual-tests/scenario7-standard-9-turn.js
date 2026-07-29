// 手动测试脚本（需要真实起服务、真实网络访问 DashScope，云端沙箱
// 环境跑不了）。标准9轮测试，走真实的 /api/chat-langgraph HTTP接口
// （不是直接调用节点函数），完整验证六项采集 + generatePlan 出方案
// 这一整条链路。
//
// 运行前先在另一个终端起服务：
//   cd backend && npm start
// 然后：
//   cd backend && node src/langgraph/manual-tests/scenario7-standard-9-turn.js
const BASE_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';

// 后三项（忌口/预算/身材目标）原本写的是话题词本身（"忌口""预算"
// "身材目标"），这是给旧的单轮生成架构准备的偷懒写法。extractSlots
// 现在已经加了黑名单，会正确拒绝这种"只复述字段名、没有具体内容"的
// 回答，所以这里换成真实、具体的回答。
//
// 注意：这9轮故意把 restrictions/goal 的答案安排在"AI还没问到这两项"
// 的时候提前说出来（第6轮"不吃香菜"、第8轮"穿衣更好看"），这是在
// "意外字段必须走确认流程"这条结构性防线（conflictRouter）上线之前
// 写的，当时这9轮足够让六项正常走完触发generatePlan。防线上线后，
// 这类"提前抢答"的意外字段会被要求走一轮确认，9轮不一定够用——这不是
// bug，是防线本身设计如此（防止编造的候选值被无脑自动确认）。真实
// 复现过这个乱序场景最终能不能收敛、需要多少轮，已经由 scenario13
// （复用同样的9轮再往后延伸）专门验证过：15轮内能正常完成，是"变慢"
// 不是"卡死"。所以这个脚本单独跑到第9轮时六项可能还没收集完，是正常
// 现象，不代表回归，只是这份注释一直没跟着更新。
const TURNS = ['你好', '靠谱吗', '食堂', '自选', '偏辣', '不吃香菜', '20元左右', '穿衣更好看', '不运动'];

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
  for (let i = 0; i < TURNS.length; i += 1) {
    const message = TURNS[i];
    console.log(`\n========== 第${i + 1}轮：用户说"${message}" ==========`);

    // eslint-disable-next-line no-await-in-loop
    const data = await sendTurn(message);

    console.log('AI回复:', data.reply);
    console.log('isComplete:', data.isComplete);
    console.log(
      '六项状态:',
      Object.entries(data.slots || {})
        .map(([k, v]) => `${k}=${v.value ?? '(空)'}${v.confirmed ? '✓' : ''}`)
        .join(' | ')
    );

    if (data.isComplete) {
      console.log('\n>>> 六项信息已全部确认，这一轮应该是 generatePlan 出的方案，重点检查以下几点：');
      console.log('    1. 有没有主动推荐大众化菜品（不是健身向/小众菜品）');
      console.log('    2. 分量描述是不是生活化类比（"一拳米饭""一掌蔬菜"），不是精确克数');
      console.log('    3. 每道菜有没有带"如果食堂没有，换成XX"这类替代方案（第43条，这次重点）');
      console.log('    4. 举例有没有过度细化到具体口味/品类');
      console.log('    5. 格式上有没有markdown加粗/列表符号/emoji/英文字母/排比反问句');
    }
  }

  console.log('\n\n=== 测试完成，threadId:', threadId, '===');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
