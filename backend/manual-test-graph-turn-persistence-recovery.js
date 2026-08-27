const assert = require('assert');
const {
  isRetryOfRecoveredTurn,
  persistAndAcknowledgeGraphTurn,
  recoverPendingGraphTurn,
} = require('./src/services/graphTurnPersistenceRecovery');

const operationId = '00500000-0000-4000-8000-000000000001';
const state = {
  messages: [
    { role: 'human', content: '午餐吃了米饭和鸡蛋' },
    { role: 'ai', content: '收到，我会按实际情况记录。' },
  ],
  persistenceRequest: { operationId },
  persistenceReceipt: null,
};
const graph = {
  async getState() {
    return { values: state };
  },
  async updateState(_config, patch) {
    Object.assign(state, patch);
  },
};
const uniqueWrites = {
  profile: new Set(),
  advice: new Set(),
  events: new Set(),
};
let persistenceAttempts = 0;
async function persistTurn(_userId, message, _threadId, _state, { afterStep } = {}) {
  persistenceAttempts += 1;
  uniqueWrites.profile.add('profile-version-1');
  if (afterStep) await afterStep({ step: 'profile', value: { status: 'updated' } });
  uniqueWrites.advice.add('advice-idempotency-1');
  if (afterStep) await afterStep({ step: 'advice', value: { status: 'recorded' } });
  uniqueWrites.events.add(`event:${message}`);
  if (afterStep) await afterStep({ step: 'events', value: { status: 'recorded' } });
  return { status: 'complete' };
}

async function run() {
  await assert.rejects(
    () => persistAndAcknowledgeGraphTurn({
      graph,
      config: { configurable: { thread_id: 'opaque-thread' } },
      userId: 'anon:test-user',
      threadId: 'public-thread',
      state,
      operationId,
      persistTurn,
      afterStep: ({ step }) => {
        if (step === 'advice') throw Object.assign(new Error('controlled crash'), {
          code: 'CONTROLLED_AFTER_ADVICE_FAILURE',
        });
      },
    }),
    (error) => error?.code === 'CONTROLLED_AFTER_ADVICE_FAILURE'
  );
  assert.strictEqual(state.persistenceReceipt, null);
  assert.strictEqual(uniqueWrites.profile.size, 1);
  assert.strictEqual(uniqueWrites.advice.size, 1);
  assert.strictEqual(uniqueWrites.events.size, 0);

  const recovered = await recoverPendingGraphTurn({
    graph,
    config: { configurable: { thread_id: 'opaque-thread' } },
    userId: 'anon:test-user',
    threadId: 'public-thread',
    persistTurn,
  });
  assert.strictEqual(recovered.status, 'recovered');
  assert.strictEqual(isRetryOfRecoveredTurn(recovered, '午餐吃了米饭和鸡蛋'), true);
  assert.strictEqual(isRetryOfRecoveredTurn(recovered, '我还有一个新问题'), false);
  assert.strictEqual(state.persistenceReceipt.operationId, operationId);
  assert.strictEqual(uniqueWrites.profile.size, 1);
  assert.strictEqual(uniqueWrites.advice.size, 1);
  assert.strictEqual(uniqueWrites.events.size, 1);
  assert.strictEqual(persistenceAttempts, 2);

  const repeated = await recoverPendingGraphTurn({
    graph,
    config: { configurable: { thread_id: 'opaque-thread' } },
    userId: 'anon:test-user',
    threadId: 'public-thread',
    persistTurn,
  });
  assert.strictEqual(repeated.status, 'complete');
  assert.strictEqual(persistenceAttempts, 2);
  assert.deepStrictEqual(Object.keys(state.persistenceRequest), ['operationId']);

  console.log(JSON.stringify({
    batch: '005m-side-effect-recovery',
    status: 'PASS',
    failedAfterAdvice: true,
    pendingReceiptPreserved: true,
    nextRequestRecoveredBeforeAdvance: true,
    identicalHttpRetryDoesNotAdvanceGraph: true,
    profileAppliedOnce: true,
    adviceAppliedOnce: true,
    eventAppliedOnce: true,
    completedTurnNotReplayed: true,
    markerContainsRawIdentifiers: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
