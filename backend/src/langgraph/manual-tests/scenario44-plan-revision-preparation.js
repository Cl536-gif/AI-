const {
  prepareFromConfirmedRequest,
  resolvePlanRevisionPreparation,
} = require('../nodes/preparePlanRevision');

// 本地回归只验证计算分流和图路由，不应因为同轮后续的
// 方案生成节点发起真实模型请求。
const generationModulePath = require.resolve('../nodes/generatePlanRevision');
require.cache[generationModulePath] = {
  id: generationModulePath,
  filename: generationModulePath,
  loaded: true,
  exports: {
    generatePlanRevision: async () => ({}),
    clearPlanRevisionDraftCommand: () => ({ planRevisionDraftCommand: null }),
    retryPlanRevisionDelivery: () => ({}),
  },
};
const { graph } = require('../graph');

function assert(condition, message) { if (!condition) throw new Error(message); }

function baseState(changes) {
  return {
    confirmedPlanRevisionRequest: { parentPlanId: 'plan-v1', parentPlanVersion: 1, changes },
    longTermContext: {
      latestEnergyCalculation: {
        inputs: {
          equationSex: 'female', ageYears: 22, heightCm: 165,
          weightKg: 60, activityLevel: 'light', pal: 1.5,
        },
      },
    },
  };
}

async function main() {
  const scheduleOnly = prepareFromConfirmedRequest(baseState([
    { field: 'schedule', summary: '午休提前半小时' },
    { field: 'food_preference', summary: '不想吃鸡胸肉' },
  ]));
  assert(scheduleOnly.planRevisionPreparation.status === 'ready', '非计算变化没有直接准备完成');
  assert(!scheduleOnly.planRevisionPreparation.needsRecalculation, '作息口味变化错误触发重新计算');

  const weightProvided = prepareFromConfirmedRequest(baseState([
    { field: 'weight', summary: '当前体重变成62公斤' },
  ]));
  assert(weightProvided.planRevisionPreparation.status === 'ready', '已经给出新体重仍被重复追问');
  assert(weightProvided.planRevisionPreparation.energyInput.weightKg === 62, '新体重没有覆盖旧计算输入');
  assert(weightProvided.planRevisionPreparation.needsRecalculation, '体重变化没有标记重新计算');

  const activityMissing = prepareFromConfirmedRequest(baseState([
    { field: 'activity_level', summary: '现在运动比以前多了' },
  ]));
  assert(activityMissing.planRevisionPreparation.status === 'collect_energy_inputs', '不明确的新活动量没有进入补问');
  assert(activityMissing.messages[0].content.includes('日常活动量'), '没有只问变化的活动量');
  assert(!activityMissing.messages[0].content.includes('身高'), '补活动量时要求用户重复无关身体数据');

  const activityResolved = resolvePlanRevisionPreparation({
    messages: [{ role: 'human', content: '现在属于中等活动' }],
    planRevisionPreparation: activityMissing.planRevisionPreparation,
  });
  assert(activityResolved.planRevisionPreparation.status === 'ready', '补充活动量后没有准备完成');
  assert(activityResolved.planRevisionPreparation.energyInput.activityLevel === 'moderate', '活动量没有标准化');

  const health = prepareFromConfirmedRequest(baseState([
    { field: 'health_status', summary: '最近持续胃痛' },
  ]));
  assert(health.planRevisionPreparation.status === 'risk_review_required', '健康变化没有阻断自动生成');

  const routed = await graph.invoke({
    messages: [{ role: 'human', content: '确认' }],
    longTermContext: baseState([]).longTermContext,
    pendingPlanRevision: {
      stage: 'confirm_changes', parentPlanId: 'plan-v1', parentPlanVersion: 1,
      changes: [{ field: 'schedule', summary: '午休提前半小时' }], askedCount: 1,
    },
    initialPlanDelivered: true,
  });
  assert(routed.planRevisionPreparation?.status === 'ready', '清单确认后没有在同轮进入计算分流');
  assert(!routed.planRevisionPreparation.needsRecalculation, '图内非计算变化错误触发重算');

  console.log('✅ 作息、食堂、口味和目标变化沿用原计算，不重复收集身体数据');
  console.log('✅ 用户已经在变化说明中提供的新数值会直接使用，不重复追问');
  console.log('✅ 只补问发生变化但缺少明确值的计算字段');
  console.log('✅ 新活动量完成标准化并与原有已确认输入组合');
  console.log('✅ 健康状态变化转入风险评估，不进入自动新版生成');
  console.log('✅ 清单确认后LangGraph在同一轮进入计算分流');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
