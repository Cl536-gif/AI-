// 手动测试脚本（需要真实起服务、真实网络访问 DashScope，云端沙箱
// 环境跑不了）。验证新增的 askServiceChoice/resolveServiceChoice 分岔：
// 六项信息采集完毕、generatePlan出方案之前，必须先问清楚"免费问答 还是
// 开通付费定期推送服务"，覆盖三个场景：
//   1. 用户选免费
//   2. 用户选订阅 → 先确认生理性别（equation_sex 门禁：长期规划只面向
//      在校女生）→ 再设定推送时间 → 出方案
//   3. 用户含糊回答两次，触发"默认按免费处理"的兜底
//
// 运行前先在另一个终端起服务：
//   cd backend && LANGGRAPH_DEBUG=1 npm start
// 然后：
//   cd backend && node src/langgraph/manual-tests/scenario17-service-choice.js
const BASE_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';

// 跟 scenario13 用的是同一套已验证收敛的乱序输入，保证能稳定跑到六项
// 全部确认完毕（isComplete变true）——这个测试关心的是六项收集完之后
// 的新分岔，不是采集本身，复用现成的、已经验证过的收敛序列，不重新
// 发明一套。
const INITIAL_TURNS = ['你好', '靠谱吗', '食堂', '自选', '偏辣', '不吃香菜', '20元左右', '穿衣更好看', '不运动'];
const FOLLOWUP_TURNS = ['对，没错', '不吃香菜', '对，没错', '穿衣更好看', '对，没错', '不运动', '对，没错', '对，没错'];

async function sendTurn(threadId, message) {
  const body = { message };
  if (threadId) body.threadId = threadId;

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// 把对话推进到六项信息全部确认完毕那一轮（isComplete变true），
// 返回这一轮的响应——这一轮的reply现在应该是askServiceChoice生成的
// 服务边界话术，不是方案本身（这正是这次要验证的行为变化）。
async function runToCompletion() {
  let threadId;
  const allTurns = [...INITIAL_TURNS, ...FOLLOWUP_TURNS];

  for (const message of allTurns) {
    // eslint-disable-next-line no-await-in-loop
    const data = await sendTurn(threadId, message);
    threadId = data.threadId;
    if (data.isComplete) {
      return { threadId, data };
    }
  }
  throw new Error('未能在预留轮次内完成六项信息采集，无法继续测试服务分岔（六项采集本身的收敛性不是这个脚本要测的，参考scenario13）');
}

function printTurn(label, data) {
  console.log(`\n${label}`);
  console.log('AI回复:', data.reply);
  console.log(
    `serviceTier: ${data.serviceTier} | pushSchedule: ${data.pushSchedule} | retrieved片段数: ${(data.retrieved || []).length}`
  );
}

async function scenarioFree() {
  console.log('\n\n########## 场景1：用户选免费 ##########');
  const { threadId, data: completionData } = await runToCompletion();
  console.log('>>> 六项采集完成，本轮应为服务边界话术，不是方案：');
  console.log('AI回复:', completionData.reply);
  console.log(
    completionData.serviceTier === null && completionData.retrieved.length === 0
      ? '✅ 六项完成的这一轮没有直接出方案，正确转入了askServiceChoice'
      : `❌ 预期serviceTier=null且retrieved为空，实际 serviceTier=${completionData.serviceTier}, retrieved长度=${completionData.retrieved.length}`
  );

  const data = await sendTurn(threadId, '先免费问问就好');
  printTurn('用户回复"先免费问问就好"：', data);
  console.log(
    data.serviceTier === 'free' && data.retrieved.length > 0
      ? '✅ 正确进入免费模式，且这一轮确实生成了方案（retrieved非空）'
      : `❌ 预期serviceTier=free且retrieved非空，实际 serviceTier=${data.serviceTier}, retrieved长度=${data.retrieved.length}`
  );
}

async function scenarioSubscribe() {
  console.log('\n\n########## 场景2：用户选订阅 → 确认生理性别 → 设定时间 ##########');
  const { threadId, data: completionData } = await runToCompletion();
  console.log('>>> 六项采集完成，服务边界话术:', completionData.reply);

  let data = await sendTurn(threadId, '我想开通推送服务');
  printTurn('用户回复"我想开通推送服务"：', data);
  console.log(
    data.serviceTier === null && /生理性别/.test(data.reply)
      ? '✅ 正确转入equation_sex阶段确认生理性别（长期规划只面向在校女生），serviceTier还没定'
      : `❌ 预期进入equation_sex且serviceTier仍为null，实际 serviceTier=${data.serviceTier}, reply含"生理性别"=${/生理性别/.test(data.reply)}`
  );

  data = await sendTurn(threadId, '生理女性');
  printTurn('用户回复"生理女性"：', data);
  console.log(
    data.serviceTier === null && /每天、隔天|再告诉我大概几点就行/.test(data.reply)
      ? '✅ 正确转入schedule阶段追问推送时间，serviceTier还没定'
      : `❌ 预期进入schedule追问时间，实际 serviceTier=${data.serviceTier}, reply含时间问询指纹=${/每天、隔天|再告诉我大概几点就行/.test(data.reply)}`
  );

  data = await sendTurn(threadId, '每天晚上7点提醒我就行');
  printTurn('用户回复"每天晚上7点提醒我就行"：', data);
  console.log(
    data.serviceTier === 'subscribed' && data.pushSchedule
      ? '✅ 正确进入订阅模式，且pushSchedule捕获到了具体时间'
      : `❌ 预期serviceTier=subscribed且pushSchedule非空，实际 serviceTier=${data.serviceTier}, pushSchedule=${data.pushSchedule}`
  );
  console.log(
    data.retrieved.length > 0 ? '✅ 这一轮确实生成了方案（retrieved非空）' : '❌ retrieved为空，方案没有正常生成'
  );
}

async function scenarioUnclearDefaultFree() {
  console.log('\n\n########## 场景3：用户含糊两次触发默认免费 ##########');
  const { threadId, data: completionData } = await runToCompletion();
  console.log('>>> 六项采集完成，服务边界话术:', completionData.reply);

  let data = await sendTurn(threadId, '嗯');
  printTurn('用户回复"嗯"（第1次含糊）：', data);
  console.log(
    data.serviceTier === null
      ? '✅ 第1次含糊，正确保留追问，还没有默认任何一边'
      : `❌ 预期serviceTier仍为null，实际 serviceTier=${data.serviceTier}`
  );

  data = await sendTurn(threadId, '再说吧');
  printTurn('用户回复"再说吧"（第2次含糊）：', data);
  console.log(
    data.serviceTier === 'free'
      ? '✅ 第2次仍含糊，正确默认按免费处理，没有默认成订阅'
      : `❌ 预期serviceTier=free（默认免费），实际 serviceTier=${data.serviceTier}`
  );
}

async function main() {
  await scenarioFree();
  await scenarioSubscribe();
  await scenarioUnclearDefaultFree();
  console.log('\n\n=== 三个场景全部跑完，对照上面每一步的结果核对状态流转 ===');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
