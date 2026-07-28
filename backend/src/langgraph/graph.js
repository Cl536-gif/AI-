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
  .addEdge('resolvePendingConfirmation', 'extractSlots')
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
