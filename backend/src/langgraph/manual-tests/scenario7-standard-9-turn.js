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
// 回答，所以这里换成真实、具体的回答，才能让六项正常走完、触发
// generatePlan。
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
