const { z } = require('zod');
const { UserIdSchema } = require('../domain/userDataContract');
const { calculateAndRecordAdultEnergy } = require('./energyCalculationService');
const { createStagePlanDraft, markOfficialPlanDelivered } = require('./stagePlanService');
const userService = require('./userService');

const CHANGE_FIELDS = [
  'weight', 'height', 'age', 'activity_level', 'equation_sex',
  'goal', 'schedule', 'meal_environment', 'food_preference', 'health_status', 'other',
];
const ENERGY_RECALCULATION_FIELDS = new Set([
  'weight', 'height', 'age', 'activity_level', 'equation_sex',
]);

const PlanRevisionChangeSchema = z.object({
  field: z.enum(CHANGE_FIELDS),
  summary: z.string().trim().min(1).max(300),
}).strict();

const ProposedPlanSchema = z.object({
  stageLabel: z.string().min(1).max(100),
  objective: z.string().min(1).max(500),
  durationDays: z.number().int().min(1).max(90),
  mealGuidance: z.array(z.object({
    mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'general']),
    guidance: z.string().min(1).max(2000),
  })).min(1).max(20),
  adjustmentRules: z.array(z.string().min(1).max(500)).max(30).default([]),
}).strict();

function requiresEnergyRecalculation(changes) {
  return changes.some((change) => ENERGY_RECALCULATION_FIELDS.has(change.field));
}

async function createPlanRevisionDraft(userId, input, {
  store,
  now = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  if (!input?.userConfirmed) throw new Error('建立新版计划草稿前必须由用户明确确认');
  const changes = z.array(PlanRevisionChangeSchema).min(1).max(20).parse(input.changes);
  if (changes.some((change) => change.field === 'health_status')) {
    throw new Error('健康或疾病状态变化需要先完成人工或专业风险评估，不能自动生成新版计划');
  }
  const parentPlan = await userService.getPlan(normalizedUserId, input.parentPlanId, { store });
  if (!parentPlan) throw new Error('要调整的上一版计划不存在');
  if (parentPlan.status !== 'paused') throw new Error('只有已经暂停的计划才能作为本流程的新版来源');
  const proposedPlan = ProposedPlanSchema.parse(input.proposedPlan);

  const recalculated = requiresEnergyRecalculation(changes);
  let calculation = null;
  let energyCalculationId = parentPlan.calculationId;
  if (recalculated) {
    if (!input.energyInput) throw new Error('身体或活动数据变化后必须先提供完整计算输入');
    calculation = await calculateAndRecordAdultEnergy(normalizedUserId, input.energyInput, { store, now });
    energyCalculationId = calculation.calculationId;
  }
  if (!energyCalculationId) throw new Error('新版计划缺少可追溯的能量计算记录');

  const changeReason = changes.map((change) => `${change.field}:${change.summary}`).join('；');
  const draft = await createStagePlanDraft(normalizedUserId, {
    ...proposedPlan,
    energyCalculationId,
  }, {
    store,
    parentPlanId: parentPlan.planId,
    changeReason,
    now,
  });
  return { draft, recalculated, calculation, changes };
}

async function deliverPlanRevision(userId, planId, {
  store,
  deliveredAt = new Date().toISOString(),
} = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const draft = await userService.getPlan(normalizedUserId, planId, { store });
  if (!draft) throw new Error('新版计划草稿不存在');
  if (!draft.parentPlanId) throw new Error('该计划不是阶段调整产生的新版');
  if (draft.status !== 'draft') throw new Error('只有尚未交付的新版草稿可以正式交付');
  return await markOfficialPlanDelivered(normalizedUserId, planId, { store, deliveredAt });
}

module.exports = {
  CHANGE_FIELDS,
  ENERGY_RECALCULATION_FIELDS,
  PlanRevisionChangeSchema,
  ProposedPlanSchema,
  requiresEnergyRecalculation,
  createPlanRevisionDraft,
  deliverPlanRevision,
};
