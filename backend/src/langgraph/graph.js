// 状态图：六项信息采集 + 出方案的完整闭环已经接通。consistencyCheck
// （场景值矛盾自查）还没实现，暂时不影响主流程——generatePlan 出的
// 方案已经接了 formatGuard 兜底，consistencyCheck 属于额外的、更细
// 的场景值一致性检查，后续视情况再补。
const { StateGraph } = require('@langchain/langgraph');
const { DietState } = require('./state');
const { extractSlots } = require('./nodes/extractSlots');
const { conflictRouter } = require('./nodes/conflictRouter');
const { askConfirmation } = require('./nodes/askConfirmation');
const { resolvePendingConfirmation } = require('./nodes/resolvePendingConfirmation');
const { checkCompleteness } = require('./nodes/checkCompleteness');
const { askNextQuestion } = require('./nodes/askNextQuestion');
const { generatePlan } = require('./nodes/generatePlan');

function routeEntry(state) {
  return state.pendingConfirmation ? 'resolvePendingConfirmation' : 'extractSlots';
}

function routeAfterResolve(state) {
  // 还悬着（用户回答没讲清楚）：再问一次同一个确认问题，这一轮到此为止，
  // 不要接着往下跑 extractSlots——不然这一轮里既在重新确认、又在采集新
  // 信息，容易把两件事搅在一起。
  return state.pendingConfirmation ? 'askConfirmation' : 'extractSlots';
}

function routeAfterConflictCheck(state) {
  return state.pendingConfirmation ? 'askConfirmation' : 'checkCompleteness';
}

function routeAfterCompleteness(state) {
  return state.isComplete ? 'generatePlan' : 'askNextQuestion';
}

const workflow = new StateGraph(DietState)
  .addNode('resolvePendingConfirmation', resolvePendingConfirmation)
  .addNode('extractSlots', extractSlots)
  .addNode('conflictRouter', conflictRouter)
  .addNode('askConfirmation', askConfirmation)
  .addNode('checkCompleteness', checkCompleteness)
  .addNode('askNextQuestion', askNextQuestion)
  .addNode('generatePlan', generatePlan)
  .addConditionalEdges('__start__', routeEntry, {
    resolvePendingConfirmation: 'resolvePendingConfirmation',
    extractSlots: 'extractSlots',
  })
  .addConditionalEdges('resolvePendingConfirmation', routeAfterResolve, {
    askConfirmation: 'askConfirmation',
    extractSlots: 'extractSlots',
  })
  .addEdge('extractSlots', 'conflictRouter')
  .addConditionalEdges('conflictRouter', routeAfterConflictCheck, {
    askConfirmation: 'askConfirmation',
    checkCompleteness: 'checkCompleteness',
  })
  .addConditionalEdges('checkCompleteness', routeAfterCompleteness, {
    askNextQuestion: 'askNextQuestion',
    generatePlan: 'generatePlan',
  })
  .addEdge('askNextQuestion', '__end__')
  .addEdge('generatePlan', '__end__')
  .addEdge('askConfirmation', '__end__');

const graph = workflow.compile();

// 也导出还没 compile 的 workflow，方便路由层用带 checkpointer 的方式
// 重新 compile 一份（服务端要靠 checkpointer + threadId 维护多轮状态，
// 而这里现成的 graph 是不带 checkpointer 的裸版本，manual-tests 里的
// 脚本都是手动在调用方自己传状态，不需要 checkpointer，两种用法并存、
// 互不影响）。
module.exports = { graph, workflow };
