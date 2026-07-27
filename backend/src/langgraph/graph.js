// 状态图：目前接到"完整性判断"这一段。askNextQuestion、generatePlan、
// consistencyCheck 还没实现，暂时先在 checkCompleteness 判断完之后
// 直接结束这一轮，后续节点做好后再把这里的 __end__ 换成真正的下一个
// 节点（这也意味着现阶段走到 checkCompleteness 之后，正常轮次还不会
// 生成任何回复文本，只会更新状态——这是预期中的过渡状态，不是bug）。
const { StateGraph } = require('@langchain/langgraph');
const { DietState } = require('./state');
const { extractSlots } = require('./nodes/extractSlots');
const { conflictRouter } = require('./nodes/conflictRouter');
const { askConfirmation } = require('./nodes/askConfirmation');
const { resolvePendingConfirmation } = require('./nodes/resolvePendingConfirmation');
const { checkCompleteness } = require('./nodes/checkCompleteness');

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
  // 占位：askNextQuestion / generatePlan 还没实现，两条分支暂时都先
  // 结束这一轮；等对应节点做好后，把下面路径表里的 '__end__' 换成
  // 'askNextQuestion' / 'generatePlan' 即可，routeAfterCompleteness
  // 本身的判断逻辑不用改。
  return state.isComplete ? 'generatePlan' : 'askNextQuestion';
}

const workflow = new StateGraph(DietState)
  .addNode('resolvePendingConfirmation', resolvePendingConfirmation)
  .addNode('extractSlots', extractSlots)
  .addNode('conflictRouter', conflictRouter)
  .addNode('askConfirmation', askConfirmation)
  .addNode('checkCompleteness', checkCompleteness)
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
    // 占位：还没有 askNextQuestion / generatePlan 节点，先都指向 __end__
    askNextQuestion: '__end__',
    generatePlan: '__end__',
  })
  .addEdge('askConfirmation', '__end__');

const graph = workflow.compile();

module.exports = { graph };
