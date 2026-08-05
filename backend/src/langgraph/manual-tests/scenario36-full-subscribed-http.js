const CHAT_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';
const ROBOTIC_PUNCTUATION = /—|－{2,}|-{2,}/;
const ENGLISH_LETTERS = /[A-Za-z]/;

async function send(message, threadId) {
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, threadId }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const result = await response.json();
  const visibleText = (result.replies || [result.reply]).join('\n');
  if (ROBOTIC_PUNCTUATION.test(visibleText)) throw new Error(`出现禁用的人机标点: ${visibleText}`);
  if (ENGLISH_LETTERS.test(visibleText)) throw new Error(`用户可见回复仍含英文字母: ${visibleText}`);
  console.log(`\n用户: ${message}`);
  console.log(`秘书: ${(result.replies || [result.reply]).join(' | ')}`);
  return result;
}

async function main() {
  let threadId;
  let result;
  const turns = [
    '你好，我是女大学生，想减脂',
    '是的',
    '食堂',
    '自选',
    '小炒肉',
    '对，另外也喜欢甜的',
    '每顿20元左右',
    '没有忌口，也没有已知过敏',
    '每周跑步两次，每次四十分钟',
    '我选择长期饮食规划',
    '每周一和周四晚上八点提醒我',
    '20岁，165厘米，现在55公斤，目标50公斤，平时上课久坐比较多，最近一个月体重没怎么变',
    '最近一次是7月20日开始，平时比较规律，经期前容易饿，也会有点腹胀',
  ];

  for (const turn of turns) {
    // eslint-disable-next-line no-await-in-loop
    result = await send(turn, threadId);
    threadId = result.threadId;
  }

  const requiredSlots = ['scene', 'taste', 'budget', 'restrictions', 'goal', 'exercise'];
  for (const key of requiredSlots) {
    if (!result.slots?.[key]?.confirmed) throw new Error(`综合流程结束后${key}仍未确认`);
  }
  if (!result.slots.taste.value.includes('小炒肉') || !result.slots.taste.value.includes('甜味')) {
    throw new Error(`综合流程口味合并错误: ${result.slots.taste.value}`);
  }
  if (result.serviceTier !== 'subscribed') throw new Error(`没有进入长期方案: ${result.serviceTier}`);
  if (result.bodyOnboardingStatus !== 'completed') {
    throw new Error(`身体数据阶段未完成: ${result.bodyOnboardingStatus}`);
  }
  if (result.bodyProfile?.ageYears !== 20 || result.bodyProfile?.heightCm !== 165 || result.bodyProfile?.currentWeightKg !== 55) {
    throw new Error(`身体数据保存错误: ${JSON.stringify(result.bodyProfile)}`);
  }
  if (result.cycleOnboardingStatus !== 'completed' || !result.menstrualProfile?.userReportedText) {
    throw new Error('经期信息没有在身体数据之后完成记录');
  }

  console.log('\n✅ 综合流程六项信息全部确认');
  console.log('✅ 长期方案、身体数据、经期信息顺序与状态全部正确');
  console.log('✅ 所有用户可见回复均未出现禁用破折号或连续横线');
  console.log('✅ 所有用户可见回复均未出现英文字母');
}

main().catch((err) => {
  console.error(`❌ 综合测试失败: ${err.message}`);
  process.exit(1);
});
