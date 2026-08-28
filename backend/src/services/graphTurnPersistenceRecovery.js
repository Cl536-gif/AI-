const { getMessageRole, getMessageText } = require('../langgraph/utils/messages');

function createRecoveryError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function normalizeOperationId(value) {
  const operationId = String(value || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(operationId)) {
    throw createRecoveryError('GRAPH_PERSISTENCE_OPERATION_INVALID');
  }
  return operationId;
}

function normalizeExternalTurn(value) {
  if (!value) return null;
  const channel = String(value.channel || '').trim();
  const requestId = String(value.requestId || '').trim();
  const inputSha256 = String(value.inputSha256 || '').trim().toLowerCase();
  const operationId = normalizeOperationId(value.operationId);
  if (channel !== 'wecom' || !/^[0-9a-f-]{36}$/.test(requestId) ||
      !/^[a-f0-9]{64}$/.test(inputSha256)) {
    throw createRecoveryError('GRAPH_EXTERNAL_TURN_INVALID');
  }
  return Object.freeze({ channel, requestId, inputSha256, operationId });
}

function externalTurnMatches(request, externalTurn) {
  const expected = normalizeExternalTurn(externalTurn);
  if (!expected || !request) return false;
  return request.channel === expected.channel &&
    request.requestId === expected.requestId &&
    request.inputSha256 === expected.inputSha256 &&
    request.operationId === expected.operationId;
}

function classifyExternalTurnSnapshot(snapshot, externalTurn) {
  const expected = normalizeExternalTurn(externalTurn);
  const state = snapshot?.values || null;
  if (!state || !state.externalTurnRequest) {
    return Object.freeze({ status: 'absent', state, snapshot });
  }
  if (!externalTurnMatches(state.externalTurnRequest, expected)) {
    return Object.freeze({ status: 'conflict', state, snapshot });
  }
  const operationId = expected.operationId;
  if (state.externalTurnReceipt?.requestId === expected.requestId &&
      state.externalTurnReceipt?.inputSha256 === expected.inputSha256 &&
      state.externalTurnReceipt?.operationId === operationId &&
      state.persistenceReceipt?.operationId === operationId) {
    return Object.freeze({ status: 'complete', state, snapshot });
  }
  if ((Array.isArray(snapshot?.next) && snapshot.next.length > 0) ||
      (Array.isArray(snapshot?.tasks) && snapshot.tasks.some((task) => !task?.result))) {
    return Object.freeze({ status: 'checkpoint_incomplete', state, snapshot });
  }
  if (state.persistenceRequest?.operationId === operationId &&
      state.persistenceReceipt?.operationId !== operationId) {
    return Object.freeze({ status: 'persistence_pending', state, snapshot });
  }
  if (state.persistenceReceipt?.operationId === operationId) {
    return Object.freeze({ status: 'receipt_pending', state, snapshot });
  }
  return Object.freeze({ status: 'conflict', state, snapshot });
}

function lastHumanMessage(state) {
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (getMessageRole(messages[index]) === 'human') {
      const text = getMessageText(messages[index]).trim();
      if (text) return text;
    }
  }
  throw createRecoveryError('GRAPH_PERSISTENCE_MESSAGE_MISSING');
}

function assertRecoveryGraph(graph) {
  if (!graph || typeof graph.getState !== 'function' || typeof graph.updateState !== 'function') {
    throw createRecoveryError('GRAPH_PERSISTENCE_CHECKPOINTER_REQUIRED');
  }
}

function isRetryOfRecoveredTurn(recovery, message) {
  if (recovery?.status !== 'recovered' || !recovery.state) return false;
  return lastHumanMessage(recovery.state) === String(message || '').trim();
}

async function acknowledge(graph, config, operationId) {
  await graph.updateState(config, {
    persistenceReceipt: { operationId },
  });
}

async function recoverPendingGraphTurn({
  graph,
  config,
  userId,
  threadId,
  persistTurn,
} = {}) {
  assertRecoveryGraph(graph);
  if (typeof persistTurn !== 'function') {
    throw createRecoveryError('GRAPH_PERSISTENCE_WRITER_REQUIRED');
  }
  const snapshot = await graph.getState(config);
  const state = snapshot?.values;
  const request = state?.persistenceRequest;
  if (!request) return Object.freeze({ status: 'none', persistence: null });
  const operationId = normalizeOperationId(request.operationId);
  if (state?.persistenceReceipt?.operationId === operationId) {
    return Object.freeze({ status: 'complete', operationId, persistence: null });
  }
  const persistence = await persistTurn(userId, lastHumanMessage(state), threadId, state);
  await acknowledge(graph, config, operationId);
  return Object.freeze({ status: 'recovered', operationId, persistence, state });
}

async function persistAndAcknowledgeGraphTurn({
  graph,
  config,
  userId,
  threadId,
  state,
  operationId,
  persistTurn,
  afterStep,
} = {}) {
  assertRecoveryGraph(graph);
  if (typeof persistTurn !== 'function') {
    throw createRecoveryError('GRAPH_PERSISTENCE_WRITER_REQUIRED');
  }
  const normalizedOperationId = normalizeOperationId(operationId);
  const persistence = await persistTurn(userId, lastHumanMessage(state), threadId, state, {
    afterStep,
  });
  await acknowledge(graph, config, normalizedOperationId);
  return persistence;
}

module.exports = {
  classifyExternalTurnSnapshot,
  externalTurnMatches,
  isRetryOfRecoveredTurn,
  lastHumanMessage,
  normalizeExternalTurn,
  persistAndAcknowledgeGraphTurn,
  recoverPendingGraphTurn,
};
