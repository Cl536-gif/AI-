// 状态图：目前接到"冲突检测/确认"这一段。checkCompleteness、
// generatePlan、consistencyCheck 还没实现，暂时先在"没有待确认冲突"
// 的分支直接结束这一轮，后续节点做好后再把这里的 __end__ 换成真正的
// 下一个节点（这也意味着现阶段"没有冲突"的正常轮次还不会生成任何
// 回复文本，只会更新状态——这是预期中的过渡状态，不是bug）。
const { StateGraph } = require('@langchain/langgraph');
const { DietState } = require('./state');
const { extractSlots } = require('./nodes/extractSlots');
const { conflictRouter } = require('./nodes/conflictRouter');
const { askConfirmation } = require('./nodes/askConfirmation');
const { resolvePendingConfirmation } = require('./nodes/resolvePendingConfirmation');

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
  return state.pendingConfirmation ? 'askConfirmation' : '__end__';
}

const workflow = new StateGraph(DietState)
  .addNode('resolvePendingConfirmation', resolvePendingConfirmation)
  .addNode('extractSlots', extractSlots)
  .addNode('conflictRouter', conflictRouter)
  .addNode('askConfirmation', askConfirmation)
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
    __end__: '__end__',
  })
  .addEdge('askConfirmation', '__end__');

const graph = workflow.compile();

module.exports = { graph };
