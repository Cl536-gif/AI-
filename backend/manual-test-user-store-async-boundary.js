const assert = require('assert');
const chatService = require('./src/services/chatService');

async function main() {
  const observations = [];
  const store = {
    async recordActivity(userId) {
      await Promise.resolve();
      observations.push({ method: 'recordActivity', userId });
      return {
        userId,
        previousActiveAt: null,
        lastActiveAt: '2026-08-25T15:00:00.000Z',
      };
    },
  };
  const userId = 'async-boundary-greeting';

  const greeting = await chatService.getGreeting({ userId, store });
  assert.strictEqual(greeting.privacyOnboardingPending, true);
  assert.strictEqual(observations.length, 1);

  const continuation = await chatService.sendChatMessage({
    userId,
    message: '继续',
    sessionId: null,
    store,
  });
  assert.strictEqual(continuation.nextRoute, 'langgraph');
  assert.strictEqual(observations.length, 2);

  console.log(JSON.stringify({
    batch: '004n-async-boundary',
    status: 'PASS',
    greetingActivityAwaited: true,
    chatActivityAwaited: true,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
