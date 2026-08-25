const { parseActivityLevel } = require('./preparePlanRevision');

const INITIAL_LONG_TERM_PLAN_DELIVERY_MESSAGE =
  '长期档案需要的信息已经齐了～第一阶段方案已经正式建立，14天免费体验从今天开始。' +
  '先按前面给你的餐食搭配执行；之后把实际吃了什么、饱不饱，以及额外运动情况告诉我，我会结合记录分阶段调整。';

function buildInitialLongTermPlanCommand(state) {
  const body = state.bodyProfile || {};
  const activityLevel = parseActivityLevel(body.dailyActivity);
  if (state.serviceTier !== 'subscribed') throw new Error('未选择长期服务，不能建立正式方案');
  if (state.equationSex !== 'female') throw new Error('当前长期方案只支持已明确为生理女性的用户');
  if (state.bodyOnboardingStatus !== 'completed') throw new Error('身体资料尚未完成，不能建立正式方案');
  if (state.cycleOnboardingStatus !== 'completed') throw new Error('经期资料尚未完成，不能建立正式方案');
  if (!activityLevel) throw new Error('日常活动量尚未标准化，不能进行能量计算');
  if (!state.initialMealPlanText) throw new Error('第一餐搭配不存在，不能建立正式方案');

  return {
    energyInput: {
      equationSex: state.equationSex,
      ageYears: body.ageYears,
      heightCm: body.heightCm,
      weightKg: body.currentWeightKg,
      activityLevel,
    },
    plan: {
      stageLabel: '第一阶段',
      objective: '先建立规律、能执行且不过度改变原有习惯的饮食结构',
      durationDays: 14,
      mealGuidance: [{ mealType: 'general', guidance: state.initialMealPlanText }],
      adjustmentRules: [
        '根据用户实际进食、饱腹感和身体状态逐步调整，不要求一次改变全部习惯',
        '用户主动反馈额外运动后，再结合时长、类型和设备数据调整当天饮食',
        '偶尔加量或吃零食后恢复正常饮食，不采用挨饿或惩罚性运动补偿',
      ],
    },
  };
}

function finalizeInitialLongTermPlan(state) {
  return {
    messages: [{ role: 'ai', content: INITIAL_LONG_TERM_PLAN_DELIVERY_MESSAGE }],
    initialLongTermPlanCommand: buildInitialLongTermPlanCommand(state),
  };
}

function clearInitialLongTermPlanCommand() {
  return { initialLongTermPlanCommand: null };
}

module.exports = {
  INITIAL_LONG_TERM_PLAN_DELIVERY_MESSAGE,
  buildInitialLongTermPlanCommand,
  finalizeInitialLongTermPlan,
  clearInitialLongTermPlanCommand,
};
