// 最小 LangGraph 状态图：单节点调用 qwen-plus
const { StateGraph, Annotation } = require('@langchain/langgraph');
const { model } = require('./model');

const StateAnnotation = Annotation.Root({
  messages: Annotation({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

async function callModel(state) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

const workflow = new StateGraph(StateAnnotation)
  .addNode('agent', callModel)
  .addEdge('__start__', 'agent')
  .addEdge('agent', '__end__');

const graph = workflow.compile();

module.exports = { graph };
