const crypto = require('crypto');
const { Annotation, StateGraph, START, END } = require('@langchain/langgraph');
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres');
const { classifyExternalTurnSnapshot } = require('../../src/services/graphTurnPersistenceRecovery');

const TestState = Annotation.Root({
  messages: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  externalTurnRequest: Annotation({ reducer: (_left, right) => right, default: () => null }),
  persistenceRequest: Annotation({ reducer: (_left, right) => right, default: () => null }),
  persistenceReceipt: Annotation({ reducer: (_left, right) => right, default: () => null }),
  externalTurnReceipt: Annotation({ reducer: (_left, right) => right, default: () => null }),
  modelReply: Annotation({ reducer: (_left, right) => right, default: () => null }),
});

function createDeterministicGraph({ pool, checkpointSchema, hook = async () => {} }) {
  const workflow = new StateGraph(TestState)
    .addNode('acceptHuman', async (state) => ({
      messages: [{
        role: 'human',
        id: `wecom:${state.externalTurnRequest.requestId}`,
        content: 'deterministic-user-message',
      }],
    }))
    .addNode('model', async (state) => {
      await hook('checkpointDurable', state.externalTurnRequest);
      await pool.query(
        'INSERT INTO app.wecom_test_model_attempts(request_id) VALUES($1)',
        [state.externalTurnRequest.requestId]
      );
      return {
        messages: [{ role: 'assistant', content: 'deterministic-reply' }],
        modelReply: 'deterministic-reply',
      };
    })
    .addEdge(START, 'acceptHuman')
    .addEdge('acceptHuman', 'model')
    .addEdge('model', END);
  const checkpointer = new PostgresSaver(pool, undefined, { schema: checkpointSchema });
  return workflow.compile({ checkpointer });
}

function createDeterministicConversationHandler({ pool, checkpointSchema, hook = async () => {} }) {
  const graph = createDeterministicGraph({ pool, checkpointSchema, hook });
  return async function deterministicConversation({ threadId, externalTurn }) {
    const config = { configurable: { thread_id: threadId } };
    let snapshot = await graph.getState(config);
    let classification = classifyExternalTurnSnapshot(snapshot, externalTurn);
    if (classification.status === 'conflict') {
      throw Object.assign(new Error('deterministic graph conflict'), {
        code: 'WECOM_GRAPH_STATE_CONFLICT',
      });
    }
    let state;
    if (classification.status === 'absent') {
      state = await graph.invoke({
        externalTurnRequest: externalTurn,
        persistenceRequest: { operationId: externalTurn.operationId },
      }, config);
      await hook('graphResultGenerated', externalTurn);
    } else if (classification.status === 'checkpoint_incomplete') {
      state = await graph.invoke(null, config);
      await hook('graphResultGenerated', externalTurn);
    } else {
      state = classification.state;
    }

    if (!state.persistenceReceipt ||
        state.persistenceReceipt.operationId !== externalTurn.operationId) {
      await pool.query(`
        INSERT INTO app.wecom_test_advice(operation_id,request_id)
        VALUES($1,$2) ON CONFLICT(operation_id) DO NOTHING
      `, [externalTurn.operationId, externalTurn.requestId]);
      const persistenceReceipt = { operationId: externalTurn.operationId };
      await graph.updateState(config, { persistenceReceipt });
      state = { ...state, persistenceReceipt };
      await hook('persistenceReceiptWritten', externalTurn);
    }

    if (!state.externalTurnReceipt ||
        state.externalTurnReceipt.requestId !== externalTurn.requestId) {
      const externalTurnReceipt = {
        ...externalTurn,
        replySha256: crypto.createHash('sha256').update(state.modelReply).digest('hex'),
      };
      await graph.updateState(config, { externalTurnReceipt });
      state = { ...state, externalTurnReceipt };
    }
    return {
      reply: state.modelReply,
      replies: [state.modelReply],
      externalTurnReceipt: state.externalTurnReceipt,
      externalTurnRecoveryStatus: classification.status,
    };
  };
}

module.exports = { createDeterministicGraph, createDeterministicConversationHandler };
