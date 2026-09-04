const BASE_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';

async function send(message, threadId) {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, threadId }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}

function joined(result) {
  return (result.replies || [result.reply]).join('\n');
}

function assertIncludes(text, patterns, label) {
  const missing = patterns.filter((pattern) => !text.includes(pattern));
  if (missing.length) throw new Error(`${label} 缺少 ${missing.join('、')}\n实际回复：${text}`);
}

async function main() {
  let threadId;
  const transcript = [];
  async function turn(message) {
    const result = await send(message, threadId);
    threadId = result.threadId;
    transcript.push({ message, replies: result.replies, result });
    console.log(`\n用户：${message}\n秘书：${joined(result)}`);
    return result;
  }

  let r = await turn('我很焦虑');
  assertIncludes(joined(r), ['私人健康饮食管理秘书', '抱抱'], '焦虑开场');
  if (/食堂还是外卖/.test(joined(r))) {
    throw new Error('情绪回复同轮仍继续了建档追问');
  }

  await turn('食堂');
  await turn('自选');
  await turn('温州米面');
  r = await turn('哦对还有锅包肉');
  assertIncludes(joined(r), ['温州米面', '锅包肉', '酸甜', '对吗'], '追加食物与综合口味确认');
  if (/预算多少/.test(joined(r))) throw new Error('综合口味确认前提前进入预算问题');

  r = await turn('对');
  assertIncludes(joined(r), ['预算'], '确认口味后进入预算');
  await turn('30');
  await turn('酸奶腹泻');
  await turn('上镜');
  r = await turn('不运动');
  assertIncludes(joined(r), ['使用方式'], '六项完成后服务选择');
  await turn('长期');
  await turn('生理女性');
  r = await turn('每隔两天');
  const plan = joined(r);
  assertIncludes(plan, ['适合午餐或晚餐', '早餐', '1.', '年龄', '身高', '当前体重'], '方案结尾与身体数据编号');
  if (/中午还是晚上|午餐还是晚餐/.test(plan)) throw new Error('方案仍在追问午餐还是晚餐');

  r = await turn('20kg, 165cm 22岁，平时上课久坐');
  assertIncludes(joined(r), ['20公斤', '确认'], '可疑体重识别确认');
  r = await turn('80公斤');
  assertIncludes(joined(r), ['22岁', '165厘米', '80公斤', '1.', '规律'], '更正体重与编号经期问题');

  r = await turn('8月4号来的三个月');
  const ambiguousCycleReply = joined(r);
  if (/周期约三个月|周期三个月/.test(ambiguousCycleReply)) {
    throw new Error(`把“来了三个月”误记成周期三个月：${ambiguousCycleReply}`);
  }
  assertIncludes(ambiguousCycleReply, ['规律还是不规律', '开始日期'], '经期歧义追问');

  r = await turn('不规律，前一次大约5月4日');
  assertIncludes(joined(r), ['周期记录', '实际状态'], '不规律周期简短回应');
  r = await turn('好的');
  const finalAck = joined(r);
  assertIncludes(finalAck, ['先按上面的饮食搭配'], '方案后简单确认');
  if (/先复述|22岁|165厘米|80公斤|月经|锅包肉\+/.test(finalAck)) {
    throw new Error(`简单确认后重复档案或完整方案：${finalAck}`);
  }

  console.log('\n✅ 用户存档对话的关键问题已按新流程完成真实 HTTP 回归');
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
