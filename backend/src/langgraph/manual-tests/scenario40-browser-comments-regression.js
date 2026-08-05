const {
  parseExplicitBodyUnits,
  findImplausibleBodyValue,
  mergeBodyProfileForTurn,
} = require('../nodes/resolveBodyOnboarding');
const { normalizeMealTimingClosing, MEAL_TIMING_CLOSING, BODY_ONBOARDING_QUESTION } = require('../nodes/generatePlan');
const { formatLongReplyForReadability } = require('../../routes/chatLanggraph');
const { answerFollowUp } = require('../nodes/answerFollowUp');

async function main() {
  const body = parseExplicitBodyUnits('20kg, 165cm 22岁');
  if (body.currentWeightKg !== 20 || body.heightCm !== 165 || body.ageYears !== 22) {
    throw new Error(`混合身体数据识别错误: ${JSON.stringify(body)}`);
  }
  if (!findImplausibleBodyValue(body)?.includes('20公斤')) {
    throw new Error('极低体重没有进入明确确认流程');
  }
  const spacedUnit = parseExplicitBodyUnits('20k g, 165c m，年龄22');
  if (spacedUnit.currentWeightKg !== 20 || spacedUnit.heightCm !== 165 || spacedUnit.ageYears !== 22) {
    throw new Error(`单位字母带空格时识别错误: ${JSON.stringify(spacedUnit)}`);
  }
  const corrected = mergeBodyProfileForTurn(
    {
      bodyProfile: {},
      pendingBodyOnboarding: {
        stage: 'confirm_implausible',
        candidateProfile: { currentWeightKg: 20, heightCm: 165, ageYears: 22 },
      },
    },
    {},
    parseExplicitBodyUnits('80公斤')
  );
  if (corrected.currentWeightKg !== 80 || corrected.heightCm !== 165 || corrected.ageYears !== 22) {
    throw new Error(`更正体重时丢失同轮年龄或身高: ${JSON.stringify(corrected)}`);
  }

  const converted = parseExplicitBodyUnits('身高1.65m，体重121斤，22岁');
  if (converted.heightCm !== 165 || converted.currentWeightKg !== 60.5) {
    throw new Error(`米/斤换算错误: ${JSON.stringify(converted)}`);
  }
  const imperial = parseExplicitBodyUnits('height 65 inches, weight 132 lbs，年龄22岁');
  if (Math.abs(imperial.heightCm - 165.1) > 0.01 || Math.abs(imperial.currentWeightKg - 59.87) > 0.01) {
    throw new Error(`英寸/磅换算错误: ${JSON.stringify(imperial)}`);
  }
  if (!BODY_ONBOARDING_QUESTION.includes('1.') || !BODY_ONBOARDING_QUESTION.includes('4.')) {
    throw new Error('身体数据问题没有编号排版');
  }

  const closing = normalizeMealTimingClosing('先吃一拳米饭。\n\n这顿你想安排在中午还是晚上呀？我可以帮你微调分量哈～');
  if (closing.includes('中午还是晚上') || !closing.includes(MEAL_TIMING_CLOSING)) {
    throw new Error(`餐次结尾兜底失败: ${closing}`);
  }

  const formatted = formatLongReplyForReadability('第一句话用于说明需要填写的数据。第二句话继续解释为什么要填写这些信息并确保内容足够长。第三句话补充用户可以使用自己熟悉的单位。第四句话说明后台会统一进行单位换算避免计算错误。第五句话继续补充活动量和目标体重属于可选信息。第六句话提醒用户无需自己计算任何内容。第七句话说明记录会用于后续阶段性评估。第八句话提醒数值变化后可以重新告诉秘书更新。第九句话说明所有计算结果都会结合实际饮食情况进行复核。');
  if (!formatted.includes('\n\n')) throw new Error('长回复没有自动分段');

  const followUp = await answerFollowUp({ messages: [{ role: 'human', content: '好的' }] });
  const followUpText = followUp.messages[0].content;
  if (!followUpText.includes('先按上面的饮食搭配') || /年龄|身高|体重|月经/.test(followUpText)) {
    throw new Error(`简单确认后仍重复档案: ${followUpText}`);
  }

  console.log('✅ 身高、体重、年龄的公制与英制单位可识别并统一换算');
  console.log('✅ 可疑身体数据不会静默丢弃，会进入确认流程');
  console.log('✅ 午晚餐不再追问，早餐明确另给方案');
  console.log('✅ 长文本自动分段，简单确认不再重复用户档案与完整方案');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
