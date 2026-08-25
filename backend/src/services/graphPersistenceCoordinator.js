const { getUserStore } = require('../stores/userStoreProvider');
const userService = require('./userService');
const { persistGraphProfile } = require('./graphProfileService');
const { buildLongTermContext } = require('./longTermContextService');
const { processLongTermUserMessage } = require('./longTermEventService');
const { selectLongTermService } = require('./longTermService');
const {
  processPlanLifecycleFromEvents,
  processPlanRecoveryChoice,
} = require('./planAdjustmentService');
const {
  createPlanRevisionDraft,
  deliverPlanRevision,
} = require('./planRevisionService');
const { confirmLongTermProfile } = require('./longTermService');
const { calculateAndRecordAdultEnergy } = require('./energyCalculationService');
const { createStagePlanDraft, markOfficialPlanDelivered } = require('./stagePlanService');
const { persistGraphAdvice } = require('./graphAdvicePersistenceService');

async function persistInitialLongTermPlan(userId, command, {
  store = getUserStore(),
  now = new Date().toISOString(),
} = {}) {
  if (!command) return { status: 'not_requested', plan: null, calculation: null };

  const currentService = await userService.getServiceStatus(userId, { store });
  if (currentService?.status === 'trial_active' && currentService.officialPlanId) {
    return {
      status: 'delivered',
      plan: await userService.getPlan(userId, currentService.officialPlanId, { store }),
      calculation: (await userService.listEnergyCalculations(userId, { limit: 1 }, { store }))[0] || null,
    };
  }

  if (currentService?.status === 'onboarding_incomplete') {
    await confirmLongTermProfile(userId, { store, now });
  } else if (currentService?.status !== 'profile_confirmed') {
    throw new Error(`当前${currentService?.status || 'free'}状态不能交付首个长期方案`);
  }

  let draft = (await userService.listPlans(userId, { limit: 50 }, { store }))
    .find((plan) => plan.status === 'draft' && plan.changeReason === 'initial_stage_plan');
  let calculation = null;
  if (!draft) {
    calculation = await calculateAndRecordAdultEnergy(userId, command.energyInput, { store, now });
    draft = await createStagePlanDraft(userId, {
      ...command.plan,
      energyCalculationId: calculation.calculationId,
    }, { store, now });
  } else {
    calculation = (await userService.listEnergyCalculations(userId, { limit: 50 }, { store }))
      .find((item) => item.calculationId === draft.calculationId) || null;
  }

  const plan = await markOfficialPlanDelivered(userId, draft.planId, { store, deliveredAt: now });
  return { status: 'delivered', plan, calculation };
}

async function persistPlanRevisionCommand(userId, command, {
  store = getUserStore(),
  now = new Date().toISOString(),
} = {}) {
  if (!command) return { status: 'not_requested', plan: null };
  if (!command.commandId) throw new Error('新版计划命令缺少幂等ID');
  const existing = await userService.getPlanRevisionCommand(userId, command.commandId, { store });
  if (existing?.status === 'delivered') {
    return {
      status: 'delivered', commandId: command.commandId,
      plan: await userService.getPlan(userId, existing.planId, { store }), recalculated: null,
      calculationId: (await userService.getPlan(userId, existing.planId, { store }))?.calculationId || null,
    };
  }

  let draft;
  let recalculated = null;
  let calculationId = null;
  if (existing?.status === 'draft_created') {
    draft = await userService.getPlan(userId, existing.planId, { store });
    if (!draft) throw new Error('新版命令已有草稿记录，但计划不存在');
  } else {
    const result = await createPlanRevisionDraft(userId, {
      userConfirmed: true,
      parentPlanId: command.parentPlanId,
      changes: command.changes,
      proposedPlan: command.proposedPlan,
      energyInput: command.needsRecalculation ? command.energyInput : undefined,
    }, { store, now });
    draft = result.draft;
    recalculated = result.recalculated;
    calculationId = result.calculation?.calculationId || draft.calculationId;
    await userService.recordPlanRevisionCommand(userId, command.commandId, {
      planId: draft.planId, status: 'draft_created', now,
    }, { store });
  }
  const activePlan = await deliverPlanRevision(userId, draft.planId, { store, deliveredAt: now });
  await userService.recordPlanRevisionCommand(userId, command.commandId, {
    planId: activePlan.planId, status: 'delivered', now,
  }, { store });
  return {
    status: 'delivered',
    commandId: command.commandId,
    plan: activePlan,
    recalculated,
    calculationId: calculationId || activePlan.calculationId,
  };
}

async function synchronizeGraphServiceChoice(userId, state, {
  store = getUserStore(),
  now = new Date().toISOString(),
} = {}) {
  // LangGraph 的历史命名 subscribed 只代表用户选择了长期路径，不能映射
  // 成已经付款的正式订阅。业务层一律先进入 onboarding_incomplete。
  if (state?.serviceTier !== 'subscribed') {
    return await userService.getServiceStatus(userId, { store });
  }
  const current = await userService.getServiceStatus(userId, { store });
  if (current && !['free', 'trial_expired', 'cancelled'].includes(current.status)) return current;
  return await selectLongTermService(userId, { store, now });
}

function createGraphPersistenceCoordinator({
  store = null,
  profileWriter = persistGraphProfile,
  contextReader = buildLongTermContext,
  eventProcessor = processLongTermUserMessage,
  planLifecycleProcessor = processPlanLifecycleFromEvents,
  planRecoveryProcessor = processPlanRecoveryChoice,
  planRevisionProcessor = persistPlanRevisionCommand,
  initialPlanProcessor = persistInitialLongTermPlan,
  adviceWriter = persistGraphAdvice,
} = {}) {
  // The production adapter is selected after route modules are loaded. Resolve
  // the provider at request time unless a test explicitly injects a store;
  // otherwise the default coordinator permanently captures the initial SQLite
  // store before configureUserStoreFromEnv() can select PostgreSQL.
  const resolveActiveStore = () => store || getUserStore();

  async function prepareContext(userId, { now = new Date().toISOString() } = {}) {
    return await contextReader(userId, { store: resolveActiveStore(), now });
  }

  async function persistTurn(userId, message, threadId, state, {
    now = new Date().toISOString(),
    timezone = 'Asia/Shanghai',
  } = {}) {
    const activeStore = resolveActiveStore();
    const profilePersistence = await profileWriter(userId, state, { store: activeStore, now });
    const advicePersistence = await adviceWriter(userId, threadId, state, { store: activeStore, now });
    const serviceStatus = await synchronizeGraphServiceChoice(
      userId, state, { store: activeStore, now }
    );
    let eventPersistence;
    try {
      eventPersistence = await eventProcessor(userId, message, {
        threadId,
        now,
        timezone,
        store: activeStore,
      });
    } catch (err) {
      // 普通事件抽取失败不能吞掉已经生成的聊天回复；返回明确状态，供日志
      // 和后续重试使用。档案写入失败则会在此前直接抛出，回复不会被发送。
      eventPersistence = {
        status: 'extraction_failed',
        extractedCount: 0,
        recordedEvents: [],
        error: err.message,
      };
    }
    const planAdjustment = await planLifecycleProcessor(
      userId, eventPersistence, { store: activeStore, now }
    );
    const planRecovery = planAdjustment.action === 'plan_paused'
      ? { status: 'awaiting_choice', action: 'none', reason: 'plan_just_paused' }
      : await planRecoveryProcessor(userId, message, { store: activeStore, now });
    // 草稿创建、计算审计和正式启用任一步失败都会抛出，路由不会把已经
    // 生成但没有持久化成功的“新版方案”返回给用户。
    const planRevision = await planRevisionProcessor(
      userId, state?.planRevisionDraftCommand, { store: activeStore, now }
    );
    const initialLongTermPlan = await initialPlanProcessor(
      userId, state?.initialLongTermPlanCommand, { store: activeStore, now }
    );
    const effectiveServiceStatus = initialLongTermPlan.status === 'delivered'
      ? await userService.getServiceStatus(userId, { store: activeStore })
      : serviceStatus;
    return {
      profilePersistence, advicePersistence, serviceStatus: effectiveServiceStatus,
      eventPersistence, planAdjustment, planRecovery,
      planRevision, initialLongTermPlan,
    };
  }

  return { prepareContext, persistTurn };
}

const defaultCoordinator = createGraphPersistenceCoordinator();

module.exports = {
  synchronizeGraphServiceChoice,
  persistPlanRevisionCommand,
  persistInitialLongTermPlan,
  createGraphPersistenceCoordinator,
  prepareGraphContext: defaultCoordinator.prepareContext,
  persistGraphTurn: defaultCoordinator.persistTurn,
};
