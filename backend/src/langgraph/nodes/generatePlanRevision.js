const crypto = require('crypto');
const { model } = require('../model');
const { ProposedPlanSchema } = require('../../services/planRevisionService');

const MEAL_LABELS = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐', general: '整体安排',
};
const DISCRETE_FOODS = '(?:水煮蛋|鸡蛋|茶叶蛋|煎蛋|鸡腿|鸡翅|苹果|香蕉|橙子|玉米|红薯)';
const INVALID_DISCRETE_PORTION_REGEX = new RegExp(
  `(?:半|一|两|二|[0-9.]+)?\\s*拳(?:头)?(?:大小)?(?:的)?\\s*${DISCRETE_FOODS}|${DISCRETE_FOODS}\\s*(?:半|一|两|二|[0-9.]+)?\\s*拳(?:头)?`,
  'i'
);

function validateFoodPortionUnits(plan) {
  for (const item of plan.mealGuidance || []) {
    if (INVALID_DISCRETE_PORTION_REGEX.test(item.guidance)) {
      throw new Error('新版方案把按个、只或块计量的食物错误写成了拳头单位');
    }
  }
  return plan;
}

function createRevisionPlanGenerator(chatModel = model) {
  return chatModel.withStructuredOutput(ProposedPlanSchema, { name: 'generate_plan_revision' });
}

function compactGenerationContext(state) {
  const profile = state.longTermContext?.profile?.profile || {};
  const pausedPlan = state.longTermContext?.pausedPlan?.plan || {};
  const request = state.confirmedPlanRevisionRequest || {};
  const preparation = state.planRevisionPreparation || {};
  return {
    profile: {
      body: profile.body || {},
      diet: profile.diet || {},
    },
    previousPlan: {
      stageLabel: pausedPlan.stageLabel || null,
      objective: pausedPlan.objective || null,
      mealGuidance: (pausedPlan.mealGuidance || []).slice(0, 8),
      adjustmentRules: (pausedPlan.adjustmentRules || []).slice(0, 8),
    },
    confirmedChanges: request.changes || [],
    energyEstimate: preparation.needsRecalculation
      ? { recalculationRequired: true, inputs: preparation.energyInput }
      : { recalculationRequired: false },
  };
}

function formatRevisionReply(plan, changes) {
  const changeLines = changes.map((change, index) => `${index + 1}. ${change.summary}`);
  const mealLines = plan.mealGuidance.map((item) =>
    `${MEAL_LABELS[item.mealType] || '饮食安排'}：${item.guidance}`);
  const ruleLines = plan.adjustmentRules.map((rule, index) => `${index + 1}. ${rule}`);
  return (
    `好，新版会从「${plan.stageLabel}」开始，重点是：${plan.objective}\n\n` +
    `这次已根据这些变化调整：\n${changeLines.join('\n')}\n\n` +
    `${mealLines.join('\n\n')}` +
    (ruleLines.length ? `\n\n接下来这样观察和调整：\n${ruleLines.join('\n')}` : '') +
    '\n\n不用补回中断的几天，也不用突然少吃。我们从现在的实际情况继续往前走。'
  );
}

function createGeneratePlanRevision({ generator = createRevisionPlanGenerator() } = {}) {
  return async function generatePlanRevision(state) {
    const preparation = state.planRevisionPreparation;
    const request = state.confirmedPlanRevisionRequest;
    if (!preparation || preparation.status !== 'ready' || !request) return {};

    const generationContext = compactGenerationContext(state);
    const proposedPlan = validateFoodPortionUnits(await generator.invoke([
      {
        role: 'system',
        content:
          '你负责根据已经确认的持续变化，生成下一阶段饮食计划的结构化内容。只能使用提供的资料，不得编造。' +
          '目标是小白可执行的科学饮食安排，不使用惩罚性节食，不追补中断天数，不承诺医学效果。' +
          '\n\n【忌口排除铁律】\n' +
          '生成方案（含所有主菜、配菜、替代方案）前，必须先检查用户档案中已声明的忌口/过敏/不耐受项。任何含有用户已声明忌口成分的菜品，必须整体排除：不得出现在主菜、配菜或任何替代方案中；也不得使用"少碰""挑出来不吃""避开里面的X"这类弱化表述来"补救"。忌口就是整体不出现，不存在"少吃一点"的版本。\n\n' +
          '餐食分量单位必须符合食物：米饭等主食可用拳或碗，蔬菜可用掌或份，鸡蛋、鸡腿、水果等必须用个、只、块或明确克数，' +
          '禁止把鸡蛋、鸡腿等写成半拳或一拳。一次改变不要过多，并保留用户真实能买到、能坚持的选择。' +
          '如果能量输入发生更新，只把它作为后台阶段安排依据，不在饮食指引里堆砌热量数字。',
      },
      { role: 'human', content: JSON.stringify(generationContext) },
    ]));
    const commandId = crypto.randomUUID();
    const userReply = formatRevisionReply(proposedPlan, request.changes);
    return {
      messages: [{ role: 'ai', content: userReply }],
      planRevisionPreparation: { ...preparation, status: 'draft_ready' },
      planRevisionDraftCommand: {
        commandId,
        parentPlanId: request.parentPlanId,
        changes: request.changes,
        proposedPlan,
        needsRecalculation: preparation.needsRecalculation,
        energyInput: preparation.energyInput,
        userReply,
      },
    };
  };
}

function clearPlanRevisionDraftCommand() {
  return {
    planRevisionDraftCommand: null,
    confirmedPlanRevisionRequest: null,
    planRevisionPreparation: null,
  };
}

function retryPlanRevisionDelivery(state) {
  const command = state.planRevisionDraftCommand;
  if (!command) return {};
  return {
    messages: [{ role: 'ai', content: command.userReply }],
    planRevisionDraftCommand: command,
  };
}

const generatePlanRevision = createGeneratePlanRevision();

module.exports = {
  MEAL_LABELS,
  INVALID_DISCRETE_PORTION_REGEX,
  validateFoodPortionUnits,
  createRevisionPlanGenerator,
  compactGenerationContext,
  formatRevisionReply,
  createGeneratePlanRevision,
  generatePlanRevision,
  clearPlanRevisionDraftCommand,
  retryPlanRevisionDelivery,
};
