// 手动测试脚本（需要真实起服务、真实网络访问 DashScope，云端沙箱
// 环境跑不了）。标准9轮测试，走真实的 /api/chat-langgraph HTTP接口
// （不是直接调用节点函数），验证六项采集这条链路。
//
// 注意：isComplete变true之后不再直接出方案——新增了askServiceChoice
// 分岔（问免费问答还是付费定期推送），这个脚本只测九轮标准采集，
// 跑到isComplete=true就结束，不延伸到服务分岔+generatePlan那一段，
// 那部分的验证见 scenario17-service-choice.js。
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
      // isComplete变true这一轮不再直接出方案——新增了askServiceChoice
      // 分岔（问免费问答还是付费定期推送），这一轮的reply应该是服务
      // 边界话术，真正的方案要等用户回答这个分岔之后（serviceTier
      // 被定下来）才会在后续某一轮出现，这个脚本只测九轮标准采集，
      // 不延伸到服务分岔，所以不再需要额外发消息去触发方案。
      console.log('\n>>> 六项信息已全部确认，这一轮应该是 askServiceChoice 问的服务边界话术，不是方案本身：');
      console.log('    1. reply里有没有说清楚"免费问答"和"付费定期推送"这两个选项');
      console.log('    2. 格式上有没有markdown加粗/列表符号/emoji/英文字母/排比反问句');
      console.log('    （方案本身要等用户回答这个分岔之后才会出现，那几条大众化菜品/分量/');
      console.log('     替代方案的检查点见 scenario17-service-choice.js 里走到 generatePlan 之后的输出）');
    }
  }

  console.log('\n\n=== 测试完成，threadId:', threadId, '===');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
