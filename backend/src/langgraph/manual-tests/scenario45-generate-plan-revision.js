const {
  createGeneratePlanRevision,
  formatRevisionReply,
  validateFoodPortionUnits,
  clearPlanRevisionDraftCommand,
} = require('../nodes/generatePlanRevision');

function assert(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  const proposedPlan = {
    stageLabel: '第二阶段',
    objective: '适应新的午休时间并保持规律饮食',
    durationDays: 14,
    mealGuidance: [
      { mealType: 'lunch', guidance: '午餐提前半小时，吃半碗到一碗米饭、1个鸡腿和1份绿叶菜。' },
      { mealType: 'dinner', guidance: '晚餐按一份主食、一份蛋白质和一份蔬菜搭配。' },
    ],
    adjustmentRules: ['连续两天明显饥饿时主动反馈，再判断是否增加加餐。'],
  };
  const generator = { async invoke() { return proposedPlan; } };
  const generate = createGeneratePlanRevision({ generator });
  const result = await generate({
    confirmedPlanRevisionRequest: {
      parentPlanId: 'plan-v1',
      changes: [{ field: 'schedule', summary: '午休提前半小时' }],
    },
    planRevisionPreparation: {
      status: 'ready', needsRecalculation: false,
      energyInput: { equationSex: 'female', ageYears: 22, heightCm: 165, weightKg: 60, activityLevel: 'light' },
    },
    longTermContext: {
      profile: { profile: { body: {}, diet: { scene: 'cafeteria' } } },
      pausedPlan: { plan: { stageLabel: '第一阶段', objective: '规律饮食', mealGuidance: [] } },
    },
  });
  assert(result.planRevisionDraftCommand.parentPlanId === 'plan-v1', '草稿命令丢失上一版关联');
  assert(result.planRevisionDraftCommand.proposedPlan.stageLabel === '第二阶段', '结构化新版计划没有进入命令');
  assert(result.planRevisionPreparation.status === 'draft_ready', '生成后没有标记草稿待持久化');
  assert(result.messages[0].content.includes('午餐：'), '用户回复没有清晰分餐排版');
  assert(result.messages[0].content.includes('不用补回中断的几天'), '新版回复缺少非惩罚性恢复说明');

  const formatted = formatRevisionReply(proposedPlan, [{ field: 'schedule', summary: '午休提前半小时' }]);
  assert(!/[—]{2,}|---/.test(formatted), '新版回复出现机械分隔符');
  assert(!formatted.includes('plan-v1'), '用户回复泄露内部计划ID');
  let invalidUnitBlocked = false;
  try {
    validateFoodPortionUnits({
      mealGuidance: [{ mealType: 'breakfast', guidance: '早餐吃半拳水煮蛋和一小碗粥。' }],
    });
  } catch (err) {
    invalidUnitBlocked = /拳头单位/.test(err.message);
  }
  assert(invalidUnitBlocked, '水煮蛋使用半拳单位时没有阻断方案');

  const cleared = clearPlanRevisionDraftCommand();
  assert(cleared.planRevisionDraftCommand === null, '一次性草稿命令没有清除');
  assert(cleared.confirmedPlanRevisionRequest === null && cleared.planRevisionPreparation === null, '新版临时状态没有一起清理');

  console.log('✅ 已准备的数据会生成结构化新版方案和一次性草稿命令');
  console.log('✅ 用户可见回复按变化、餐次和观察规则清晰分段');
  console.log('✅ 回复不泄露内部ID，也不要求追补或惩罚性少吃');
  console.log('✅ 鸡蛋、鸡腿和水果等离散食物使用拳头单位会阻断交付');
  console.log('✅ 草稿命令在下一轮入口清除，避免重复创建版本');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
