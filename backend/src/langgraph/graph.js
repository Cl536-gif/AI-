// 状态图：六项信息采集 + 出方案的完整闭环已经接通。consistencyCheck
// （场景值矛盾自查）还没实现，暂时不影响主流程——generatePlan 出的
// 方案已经接了 formatGuard 兜底，consistencyCheck 属于额外的、更细
// 的场景值一致性检查，后续视情况再补。
//
// 重要：resolvePendingConfirmation 之后无条件继续走 extractSlots，
// 不管旧的待确认事项这一轮有没有被解决——用户完全可能在等待确认的
// 同时持续给出新信息，不能因为旧确认没解决就把新信息全部吞掉（这是
// 真实测试里复现过的一个死锁bug：resolvePendingConfirmation判定"没
// 讲清楚"后如果直接跳过extractSlots，后续所有轮次的新信息都会被
// 无声丢弃，AI只会一直重复问同一个确认问题）。是否要重新问那个悬而
// 未决的确认，交给 conflictRouter 之后的 routeAfterConflictCheck
// 统一判断（它检查的是最终的 state.pendingConfirmation，不关心这个
// 值到底是"旧的还没解决"还是"这一轮才新产生的"）。
//
// askServiceChoice/resolveServiceChoice：六项信息采集完毕之后、
// generatePlan出方案之前插入的服务边界问询（免费问答 vs 付费定期
// 推送），用法上完全比照 askConfirmation/resolvePendingConfirmation
// 那一对"问-等-解析"的结构，包括含糊重问、超过次数上限后按默认值
// 收尾这几个惯例。
const { StateGraph } = require('@langchain/langgraph');
const { DietState } = require('./state');
const { extractSlots } = require('./nodes/extractSlots');
const { conflictRouter } = require('./nodes/conflictRouter');
const { askConfirmation } = require('./nodes/askConfirmation');
const { resolvePendingConfirmation } = require('./nodes/resolvePendingConfirmation');
const { checkCompleteness } = require('./nodes/checkCompleteness');
const { askNextQuestion } = require('./nodes/askNextQuestion');
const { askServiceChoice } = require('./nodes/askServiceChoice');
const { resolveServiceChoice } = require('./nodes/resolveServiceChoice');
const { resolveCycleOnboarding } = require('./nodes/resolveCycleOnboarding');
const { resolveBodyOnboarding } = require('./nodes/resolveBodyOnboarding');
const { generatePlan } = require('./nodes/generatePlan');
const { provideEmotionalSupport } = require('./nodes/provideEmotionalSupport');
const { answerFollowUp } = require('./nodes/answerFollowUp');
const { detectDirectQuestion, answerDirectQuestion } = require('./nodes/directQuestion');
const { getMessageText, findLastUserMessage } = require('./utils/messages');
const { NEW_PLAN_REGEX } = require('../services/planAdjustmentService');
const {
  startPlanRevision,
  resolvePlanRevision,
} = require('./nodes/resolvePlanRevision');
const {
  prepareFromConfirmedRequest,
  resolvePlanRevisionPreparation,
} = require('./nodes/preparePlanRevision');
const {
  generatePlanRevision,
  clearPlanRevisionDraftCommand,
  retryPlanRevisionDelivery,
} = require('./nodes/generatePlanRevision');
const {
  finalizeInitialLongTermPlan,
  clearInitialLongTermPlanCommand,
} = require('./nodes/finalizeInitialLongTermPlan');

function shouldRouteReturningUserToFollowUp(state) {
  // 已经取得长期服务上下文，就说明这个身份已经完成长期建档并进入了
  // 持续服务阶段。这里不能再受旧 thread 里残留的六项槽位影响，否则
  // 用户重复说“我是女大学生、想减脂”时会被误送回首次采集流程。
  if (state.longTermContext?.accessMode === 'long_term') return true;
  const hasPersistedProfile = Boolean(state.longTermContext?.profile?.profile);
  const graphSlotsAreEmpty = Object.values(state.slots || {}).every(
    (slot) => !slot?.confirmed && (slot?.value === null || slot?.value === undefined)
  );
  return hasPersistedProfile && graphSlotsAreEmpty;
}

// 情绪命中轮确定性收口（情绪链刀1d 手术 F）：provideEmotionalSupport
// 命中情绪并发出固定安抚文案后，本轮即告完成——不再进入 detectDirectQuestion
// 及其后的模型节点。情绪固定文案已经覆盖「安抚 + 方向 + 陪伴」，模型再参与
// 只会重复安慰（模型无法被提示词可靠禁止，见刀1c T2a 判挂）；确定性要覆盖
// 整条回复链：固定话术答完，后续节点不能把球踢回给模型。
// flag 由 langgraphConversationService 每轮 invoke input 强制清零（手术 C），
// 故此边只在情绪真正命中的那一轮收口，不会跨轮误吞。
function routeAfterEmotionalSupport(state) {
  return state.emotionalSupportDeliveredThisTurn === true ? '__end__' : 'detectDirectQuestion';
}

function routeEntry(state) {
  if (state.initialLongTermPlanCommand) return 'clearInitialLongTermPlanCommand';
  if (state.planRevisionDraftCommand) {
    const activePlan = state.longTermContext?.activePlan;
    return activePlan?.parentPlanId === state.planRevisionDraftCommand.parentPlanId
      ? 'clearPlanRevisionDraftCommand'
      : 'retryPlanRevisionDelivery';
  }
  if (state.directQuestion) return 'answerDirectQuestion';
  if (state.planRevisionPreparation?.status === 'collect_energy_inputs') return 'resolvePlanRevisionPreparation';
  if (state.pendingPlanRevision) return 'resolvePlanRevision';
  if (state.pendingConfirmation) return 'resolvePendingConfirmation';
  if (state.pendingServiceChoice) return 'resolveServiceChoice';
  if (state.pendingBodyOnboarding) return 'resolveBodyOnboarding';
  if (state.pendingCycleOnboarding) return 'resolveCycleOnboarding';
  const userText = getMessageText(findLastUserMessage(state.messages)).replace(/\s+/g, '');
  if (state.longTermContext?.pausedPlan && NEW_PLAN_REGEX.test(userText)) return 'startPlanRevision';
  // 新 threadId 的图状态必然从空槽位开始，但同一身份的业务档案不会随
  // 会话一起清空。已有档案且图槽位仍全部为空，说明这是老用户开启的
  // 新对话：直接按当前问题回复，不能重新走首次自我介绍和六项采集。
  // 同一首次建档会话不受影响，因为第二轮开始时至少已有一个图槽位。
  if (shouldRouteReturningUserToFollowUp(state)) return 'answerFollowUp';
  return 'extractSlots';
}

// 问题已经单独回答，但必须继续处理同一条用户消息。这样一句“今天怎么
// 吃，我晚上会跑步40分钟”既会先获得当餐答案，也不会丢掉运动信息。
// 对已有完整档案、当前没有待办收集步骤的用户则直接结束，避免再由
// answerFollowUp把同一个问题回答第二次。
function routeAfterDirectQuestion(state) {
  if (state.planRevisionPreparation?.status === 'collect_energy_inputs') return 'resolvePlanRevisionPreparation';
  if (state.pendingPlanRevision) return 'resolvePlanRevision';
  if (state.pendingConfirmation) return 'resolvePendingConfirmation';
  if (state.pendingServiceChoice) return 'resolveServiceChoice';
  if (state.pendingBodyOnboarding) return 'resolveBodyOnboarding';
  if (state.pendingCycleOnboarding) return 'resolveCycleOnboarding';
  const userText = getMessageText(findLastUserMessage(state.messages)).replace(/\s+/g, '');
  if (state.longTermContext?.pausedPlan && NEW_PLAN_REGEX.test(userText)) return 'startPlanRevision';
  if (shouldRouteReturningUserToFollowUp(state) || state.initialPlanDelivered) return '__end__';
  return 'extractSlots';
}

function routeAfterCycleOnboarding(state) {
  return state.serviceTier === 'subscribed' &&
    state.equationSex === 'female' &&
    state.bodyOnboardingStatus === 'completed' &&
    state.cycleOnboardingStatus === 'completed'
    ? 'finalizeInitialLongTermPlan'
    : '__end__';
}

function routeAfterPlanRevision(state) {
  return state.confirmedPlanRevisionRequest ? 'preparePlanRevision' : '__end__';
}

function routeAfterRevisionPreparation(state) {
  return state.planRevisionPreparation?.status === 'ready' ? 'generatePlanRevision' : '__end__';
}

function routeAfterConflictCheck(state) {
  return state.pendingConfirmation ? 'askConfirmation' : 'checkCompleteness';
}

// 六项信息采集完毕之后，出方案前必须先问清楚"免费问答 还是 开通付费
// 推送服务"这个分岔（state.serviceTier）——没问清楚之前不能直接走
// generatePlan，也不能默认选任何一边。
function routeAfterCompleteness(state) {
  if (!state.isComplete) return 'askNextQuestion';
  if (state.serviceTier === null) return 'askServiceChoice';
  if (state.initialPlanDelivered) return 'answerFollowUp';
  return 'generatePlan';
}

// resolveServiceChoice 判断完之后：pendingServiceChoice 还非空，说明
// 还在等用户明确回答（含糊重问，或者从choice阶段转入schedule阶段问
// 推送时间），送回askServiceChoice继续问；已经有结论（free或者
// subscribed）就放行到generatePlan。
function routeAfterServiceChoice(state) {
  if (state.pendingServiceChoice?.deferred || state.pendingServiceChoice?.paused) return '__end__';
  return state.pendingServiceChoice ? 'askServiceChoice' : 'generatePlan';
}

function routeAfterAskingServiceChoice(state) {
  return state.pendingServiceChoice ? '__end__' : 'generatePlan';
}

const workflow = new StateGraph(DietState)
  .addNode('provideEmotionalSupport', provideEmotionalSupport)
  .addNode('detectDirectQuestion', detectDirectQuestion)
  .addNode('answerDirectQuestion', answerDirectQuestion)
  .addNode('answerFollowUp', answerFollowUp)
  .addNode('finalizeInitialLongTermPlan', finalizeInitialLongTermPlan)
  .addNode('clearInitialLongTermPlanCommand', clearInitialLongTermPlanCommand)
  .addNode('startPlanRevision', startPlanRevision)
  .addNode('resolvePlanRevision', resolvePlanRevision)
  .addNode('preparePlanRevision', prepareFromConfirmedRequest)
  .addNode('resolvePlanRevisionPreparation', resolvePlanRevisionPreparation)
  .addNode('generatePlanRevision', generatePlanRevision)
  .addNode('clearPlanRevisionDraftCommand', clearPlanRevisionDraftCommand)
  .addNode('retryPlanRevisionDelivery', retryPlanRevisionDelivery)
  .addNode('resolvePendingConfirmation', resolvePendingConfirmation)
  .addNode('extractSlots', extractSlots)
  .addNode('conflictRouter', conflictRouter)
  .addNode('askConfirmation', askConfirmation)
  .addNode('checkCompleteness', checkCompleteness)
  .addNode('askNextQuestion', askNextQuestion)
  .addNode('askServiceChoice', askServiceChoice)
  .addNode('resolveServiceChoice', resolveServiceChoice)
  .addNode('resolveBodyOnboarding', resolveBodyOnboarding)
  .addNode('resolveCycleOnboarding', resolveCycleOnboarding)
  .addNode('generatePlan', generatePlan)
  .addEdge('__start__', 'provideEmotionalSupport')
  .addConditionalEdges('provideEmotionalSupport', routeAfterEmotionalSupport, {
    detectDirectQuestion: 'detectDirectQuestion',
    __end__: '__end__',
  })
  .addConditionalEdges('detectDirectQuestion', routeEntry, {
    answerDirectQuestion: 'answerDirectQuestion',
    resolvePendingConfirmation: 'resolvePendingConfirmation',
    resolveServiceChoice: 'resolveServiceChoice',
    resolveBodyOnboarding: 'resolveBodyOnboarding',
    resolveCycleOnboarding: 'resolveCycleOnboarding',
    startPlanRevision: 'startPlanRevision',
    resolvePlanRevision: 'resolvePlanRevision',
    resolvePlanRevisionPreparation: 'resolvePlanRevisionPreparation',
    clearPlanRevisionDraftCommand: 'clearPlanRevisionDraftCommand',
    retryPlanRevisionDelivery: 'retryPlanRevisionDelivery',
    clearInitialLongTermPlanCommand: 'clearInitialLongTermPlanCommand',
    answerFollowUp: 'answerFollowUp',
    extractSlots: 'extractSlots',
  })
  .addConditionalEdges('answerDirectQuestion', routeAfterDirectQuestion, {
    resolvePendingConfirmation: 'resolvePendingConfirmation',
    resolveServiceChoice: 'resolveServiceChoice',
    resolveBodyOnboarding: 'resolveBodyOnboarding',
    resolveCycleOnboarding: 'resolveCycleOnboarding',
    startPlanRevision: 'startPlanRevision',
    resolvePlanRevision: 'resolvePlanRevision',
    resolvePlanRevisionPreparation: 'resolvePlanRevisionPreparation',
    extractSlots: 'extractSlots',
    __end__: '__end__',
  })
  .addEdge('resolvePendingConfirmation', 'extractSlots')
  .addEdge('extractSlots', 'conflictRouter')
  .addConditionalEdges('conflictRouter', routeAfterConflictCheck, {
    askConfirmation: 'askConfirmation',
    checkCompleteness: 'checkCompleteness',
  })
  .addConditionalEdges('checkCompleteness', routeAfterCompleteness, {
    askNextQuestion: 'askNextQuestion',
    askServiceChoice: 'askServiceChoice',
    generatePlan: 'generatePlan',
    answerFollowUp: 'answerFollowUp',
  })
  .addConditionalEdges('resolveServiceChoice', routeAfterServiceChoice, {
    askServiceChoice: 'askServiceChoice',
    generatePlan: 'generatePlan',
    __end__: '__end__',
  })
  .addEdge('askNextQuestion', '__end__')
  .addConditionalEdges('askServiceChoice', routeAfterAskingServiceChoice, {
    __end__: '__end__',
    generatePlan: 'generatePlan',
  })
  .addEdge('generatePlan', '__end__')
  .addEdge('answerFollowUp', '__end__')
  .addEdge('resolveBodyOnboarding', '__end__')
  .addEdge('askConfirmation', '__end__')
  .addConditionalEdges('resolveCycleOnboarding', routeAfterCycleOnboarding, {
    finalizeInitialLongTermPlan: 'finalizeInitialLongTermPlan',
    __end__: '__end__',
  })
  .addEdge('finalizeInitialLongTermPlan', '__end__')
  .addEdge('clearInitialLongTermPlanCommand', 'answerFollowUp');
workflow
  .addEdge('startPlanRevision', '__end__')
  .addConditionalEdges('resolvePlanRevision', routeAfterPlanRevision, {
    preparePlanRevision: 'preparePlanRevision',
    __end__: '__end__',
  })
  .addConditionalEdges('preparePlanRevision', routeAfterRevisionPreparation, {
    generatePlanRevision: 'generatePlanRevision',
    __end__: '__end__',
  })
  .addConditionalEdges('resolvePlanRevisionPreparation', routeAfterRevisionPreparation, {
    generatePlanRevision: 'generatePlanRevision',
    __end__: '__end__',
  })
  .addEdge('generatePlanRevision', '__end__')
  .addEdge('clearPlanRevisionDraftCommand', 'extractSlots')
  .addEdge('retryPlanRevisionDelivery', '__end__');

const graph = workflow.compile();

// 也导出还没 compile 的 workflow，方便路由层用带 checkpointer 的方式
// 重新 compile 一份（服务端要靠 checkpointer + threadId 维护多轮状态，
// 而这里现成的 graph 是不带 checkpointer 的裸版本，manual-tests 里的
// 脚本都是手动在调用方自己传状态，不需要 checkpointer，两种用法并存、
// 互不影响）。
module.exports = {
  graph,
  workflow,
  routeAfterEmotionalSupport,
  routeEntry,
  routeAfterDirectQuestion,
  routeAfterServiceChoice,
  shouldRouteReturningUserToFollowUp,
};
