const { normalizeTasteFromContext } = require('../nodes/extractSlots');
const {
  askServiceChoice,
  SUBSCRIPTION_ONBOARDING_OVERVIEW,
  SCHEDULE_QUESTION_MESSAGE,
} = require('../nodes/askServiceChoice');
const { BODY_ONBOARDING_QUESTION, CYCLE_ONBOARDING_QUESTION } = require('../nodes/generatePlan');
const { buildCycleRecordAck } = require('../nodes/resolveCycleOnboarding');

async function main() {
  for (const food of ['香蕉飞饼', '煎饼']) {
    const result = normalizeTasteFromContext({
      userText: food,
      lastAskedSlot: 'taste',
      extractedValue: null,
    });
    if (result.value !== `喜欢${food}`) throw new Error(`${food}没有作为开放菜名口味回答落档`);
  }

  const scheduleAsk = await askServiceChoice({
    pendingServiceChoice: { stage: 'schedule', askedCount: 0 },
  });
  if (scheduleAsk.messages.length !== 2) throw new Error('选择长期后没有拆成两条消息');
  if (scheduleAsk.messages[0].content !== SUBSCRIPTION_ONBOARDING_OVERVIEW) throw new Error('缺少两三分钟采集概览');
  if (scheduleAsk.messages[1].content !== SCHEDULE_QUESTION_MESSAGE || !SCHEDULE_QUESTION_MESSAGE.includes('下一餐想吃什么')) {
    throw new Error('没有解释饮食提醒的实际内容');
  }

  if (/换算|请带上单位|可选/.test(BODY_ONBOARDING_QUESTION)) throw new Error('身体数据问题仍有后台腔调');
  if (!BODY_ONBOARDING_QUESTION.includes('如果你想跟我说')) throw new Error('附加身体信息没有改成自然邀请');
  if (/自愿|可能的日期范围|准确日期|跳过/.test(CYCLE_ONBOARDING_QUESTION)) throw new Error('经期问题仍展示后台机制或“自愿跳过”措辞');
  if (!CYCLE_ONBOARDING_QUESTION.includes('结合你的个人节奏')) throw new Error('经期问题没有说明对个人饮食安排的价值');

  const ack = buildCycleRecordAck({ regularity: 'irregular', startDates: ['本月上周'], symptoms: ['疲劳'] });
  if (ack.includes('已经记下') || ack.includes('开始日期') || ack.length > 80) throw new Error(`经期回应仍然冗长: ${ack}`);

  console.log('✅ 香蕉飞饼、煎饼无需预先进入菜品库也能识别为口味回答');
  console.log('✅ 选择长期后先发三项概览，2.5秒后再解释饮食提醒并询问频率');
  console.log('✅ 身体数据与经期话术已去除后台腔调，经期确认保持简短');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
