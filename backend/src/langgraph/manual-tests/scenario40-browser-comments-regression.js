const {
  parseExplicitBodyUnits,
  findImplausibleBodyValue,
  mergeBodyProfileForTurn,
  sanitizeBodyExtractionByEvidence,
} = require('../nodes/resolveBodyOnboarding');
const {
  normalizeMealTimingClosing,
  hasConcreteMealPlanContent,
  MEAL_TIMING_CLOSING,
  BODY_ONBOARDING_QUESTION,
} = require('../nodes/generatePlan');
const { formatLongReplyForReadability } = require('../../routes/chatLanggraph');
const { answerFollowUp } = require('../nodes/answerFollowUp');
const { detectFormatViolations } = require('../../services/formatGuard');
const {
  detectUnconfirmedSlotAssertions,
  detectMisleadingCollectionProgress,
  stripOrphanLeadingColon,
} = require('../nodes/askNextQuestion');
const { extractExplicitCycleDates, mergeCycleProfile, cycleProfileNeedsMore } = require('../nodes/resolveCycleOnboarding');

async function main() {
  if (stripOrphanLeadingColon('：需要避开羊肉～ 那最后想问问你') !== '需要避开羊肉～ 那最后想问问你') {
    throw new Error('句首孤立中文冒号没有被正确清理');
  }
  if (stripOrphanLeadingColon(': 需要避开羊肉～') !== '需要避开羊肉～') {
    throw new Error('句首孤立英文冒号没有被正确清理');
  }

  const cafeteriaPathBeforeRestrictions = {
    scene: { value: '食堂', confirmed: true },
    cafeteriaMode: { value: '自选', confirmed: true },
    taste: { value: '偏辣', confirmed: true },
    budget: { value: '30元以内', confirmed: true },
    restrictions: { value: null, confirmed: false },
    goal: { value: null, confirmed: false },
    exercise: { value: null, confirmed: false },
  };
  const budgetProgressViolation = detectMisleadingCollectionProgress(
    '30元以内一顿是吧，好的～ 现在还差最后一个小问题：有没有吃了会不舒服的食物？',
    cafeteriaPathBeforeRestrictions
  );
  if (!budgetProgressViolation.some((item) => item.type === 'misleading_collection_progress')) {
    throw new Error('预算后仍缺三项时，“还差最后一个”没有被状态确定性拦截');
  }

  const cafeteriaPathBeforeGoal = {
    ...cafeteriaPathBeforeRestrictions,
    restrictions: { value: '需要避开羊肉', confirmed: true },
  };
  const restrictionProgressViolation = detectMisleadingCollectionProgress(
    '需要避开羊肉～ 那最后想问问你：这次调整饮食最希望达到什么目标？',
    cafeteriaPathBeforeGoal
  );
  if (!restrictionProgressViolation.some((item) => item.type === 'misleading_collection_progress')) {
    throw new Error('忌口后仍缺两项时，“最后想问问你”没有被状态确定性拦截');
  }
  const unseenWordingViolation = detectMisleadingCollectionProgress(
    '那最后再确认一个小但重要的点：有没有需要避开的食物？',
    cafeteriaPathBeforeRestrictions
  );
  if (!unseenWordingViolation.some((item) => item.type === 'misleading_collection_progress')) {
    throw new Error('真实回放新出现的“最后再确认一个”变体没有被状态确定性拦截');
  }

  const cafeteriaPathBeforeExercise = {
    ...cafeteriaPathBeforeGoal,
    goal: { value: '拍照更上镜', confirmed: true },
  };
  if (detectMisleadingCollectionProgress('最后了解一下：最近有在规律运动吗？', cafeteriaPathBeforeExercise).length) {
    throw new Error('实际只剩运动一项时，被错误判成进度播报矛盾');
  }

  const body = parseExplicitBodyUnits('20kg, 165cm 22岁');
  if (body.currentWeightKg !== 20 || body.heightCm !== 165 || body.ageYears !== 22) {
    throw new Error(`混合身体数据识别错误: ${JSON.stringify(body)}`);
  }
  if (!findImplausibleBodyValue(body)?.includes('20公斤')) {
    throw new Error('极低体重没有进入明确确认流程');
  }
  const hallucinatedActivity = sanitizeBodyExtractionByEvidence(
    { ageYears: 22, heightCm: 165, currentWeightKg: 20, dailyActivity: '久坐' },
    '20kg, 165cm 22岁'
  );
  if (hallucinatedActivity.dailyActivity) {
    throw new Error('用户没有提供活动量时，模型补出的活动量没有被清除');
  }
  const explicitActivity = sanitizeBodyExtractionByEvidence(
    { dailyActivity: '上课久坐为主' },
    '平时上课久坐比较多'
  );
  if (!explicitActivity.dailyActivity) throw new Error('用户明确提供的活动量被错误清除');
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
  const duplicateBreakfast = normalizeMealTimingClosing('先吃一拳米饭。想安排早餐的话随时告诉我哈～');
  if ((duplicateBreakfast.match(/早餐/g) || []).length !== 2 || duplicateBreakfast.includes('随时告诉我')) {
    throw new Error(`早餐提示没有去重: ${duplicateBreakfast}`);
  }
  if (hasConcreteMealPlanContent('接下来想确认年龄和体重。这份搭配适合午餐或晚餐。')) {
    throw new Error('只有建档问题和方案结尾的回复被误判为完整方案');
  }
  if (!hasConcreteMealPlanContent('主食打一拳杂粮饭，蛋白质选一掌鸡腿肉，再配一份清炒青菜。')) {
    throw new Error('包含食物类别和生活化分量的正常方案被误判为缺失');
  }
  const mixedDishViolations = detectFormatViolations('小炒肉吃一拳大小，大概3-4片，再配一拳米饭。');
  if (!mixedDishViolations.some((item) => item.type === 'fixed_piece_count_for_mixed_dish')) {
    throw new Error('混合炒菜使用数字范围限定片数时没有被拦截');
  }

  const fabricatedExercise = detectUnconfirmedSlotAssertions(
    '好，记下了：食堂自己打饭、喜欢小炒肉和甜味、暂不运动、目标是减脂。还差预算这一项。',
    {
      scene: { value: '食堂', confirmed: true },
      taste: { value: '小炒肉、甜味', confirmed: true },
      goal: { value: '减脂', confirmed: true },
      exercise: { value: null, confirmed: false },
    }
  );
  if (!fabricatedExercise.some((item) => item.type === 'asserts_unconfirmed_slot')) {
    throw new Error('未回答运动时，摘要编造“暂不运动”没有被拦截');
  }
  const exerciseQuestionExample = detectUnconfirmedSlotAssertions(
    '最后了解一下活动情况：目前没运动也可以直接说，你平时会做哪些运动呀？',
    { exercise: { value: null, confirmed: false } }
  );
  if (exerciseQuestionExample.length > 0) {
    throw new Error(`问题里的举例被误判为已确认事实: ${JSON.stringify(exerciseQuestionExample)}`);
  }
  const firstCycleTurn = mergeCycleProfile(
    {},
    { regularity: 'unknown', startDates: extractExplicitCycleDates('8月4号来的三个月'), typicalCycleDays: null, symptoms: [] },
    '8月4号来的三个月'
  );
  const secondCycleTurn = mergeCycleProfile(
    firstCycleTurn,
    { regularity: 'irregular', startDates: extractExplicitCycleDates('不规律，前一次大约5月4日'), typicalCycleDays: null, symptoms: [] },
    '不规律，前一次大约5月4日'
  );
  if (secondCycleTurn.startDates.length !== 2 || cycleProfileNeedsMore(secondCycleTurn)) {
    throw new Error(`分两轮提供的经期日期没有正确累积: ${JSON.stringify(secondCycleTurn)}`);
  }

  const formatted = formatLongReplyForReadability('第一句话用于说明需要填写的数据。第二句话继续解释为什么要填写这些信息并确保内容足够长。第三句话补充用户可以使用自己熟悉的单位。第四句话说明后台会统一进行单位换算避免计算错误。第五句话继续补充活动量和目标体重属于可选信息。第六句话提醒用户无需自己计算任何内容。第七句话说明记录会用于后续阶段性评估。第八句话提醒数值变化后可以重新告诉秘书更新。第九句话说明所有计算结果都会结合实际饮食情况进行复核。');
  if (!formatted.includes('\n\n')) throw new Error('长回复没有自动分段');

  const followUp = await answerFollowUp({ messages: [{ role: 'human', content: '好的' }] });
  const followUpText = followUp.messages[0].content;
  if (!followUpText.includes('新的饮食情况') || /按上面的饮食搭配|年龄|身高|体重|月经/.test(followUpText)) {
    throw new Error(`简单确认后仍重复档案: ${followUpText}`);
  }

  console.log('✅ 身高、体重、年龄的公制与英制单位可识别并统一换算');
  console.log('✅ 可疑身体数据不会静默丢弃，会进入确认流程');
  console.log('✅ 午晚餐不再追问，早餐明确另给方案');
  console.log('✅ 长文本自动分段，简单确认不再重复用户档案与完整方案');
  console.log('✅ 未确认字段不会被提前写进“已记录”摘要，问题里的示例不误伤');
  console.log('✅ 食堂→自选→辣→30→羊肉→上镜路径的冒号与错误“最后一个”播报已被确定性拦截');
  console.log('✅ 分多轮提供的经期日期会累积，“来了三个月”不会被当成周期长度');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
