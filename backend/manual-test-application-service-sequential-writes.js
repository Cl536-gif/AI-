const { persistGraphAdvice } = require('./src/services/graphAdvicePersistenceService');
const { createLongTermEventProcessor } = require('./src/services/longTermEventService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createConcurrencyProbe() {
  let active = 0;
  let maxActive = 0;
  const order = [];

  async function write(label, value) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    order.push(`end:${label}`);
    active -= 1;
    return value;
  }

  return {
    write,
    getMaxActive: () => maxActive,
    getOrder: () => [...order],
  };
}

async function verifyAdviceWritesAreSequential() {
  const probe = createConcurrencyProbe();
  const store = {
    recordAdvice: async (_userId, advice) => probe.write(advice.adviceType, advice),
  };
  const result = await persistGraphAdvice(
    'anon:004o-advice-user',
    'thread-004o-advice',
    {
      serviceTier: 'free',
      initialMealPlanText: '午餐建议：一份主食、一份蛋白质和两份蔬菜。',
      initialPlanDelivered: true,
      messages: [
        { role: 'human', content: '晚餐怎么吃？' },
        { role: 'assistant', content: '晚餐建议主食减半，搭配蛋白质和蔬菜。' },
      ],
    },
    { store, now: '2026-08-25T16:00:00+08:00' },
  );

  assert(result.records.length === 2, '没有写入两条去重后的建议');
  assert(probe.getMaxActive() === 1, '建议记录在单连接池下仍并发写入');
  assert(
    probe.getOrder().join(',') ===
      'start:initial_meal_plan,end:initial_meal_plan,start:ad_hoc_meal_advice,end:ad_hoc_meal_advice',
    '建议记录顺序与对话顺序不一致',
  );
}

async function verifyEventWritesAreSequential() {
  const probe = createConcurrencyProbe();
  const store = {
    getServiceStatus: async () => ({ status: 'subscribed' }),
    appendEvent: async (event) => probe.write(event.eventType, event),
  };
  const processor = createLongTermEventProcessor({
    store,
    extractEvents: async () => [
      {
        eventType: 'meal',
        occurredAt: '2026-08-25T12:00:00+08:00',
        payload: { summary: '吃了午餐' },
        source: 'user',
        idempotencyKey: '004o-event-meal',
      },
      {
        eventType: 'exercise',
        occurredAt: '2026-08-25T13:00:00+08:00',
        payload: { summary: '饭后散步' },
        source: 'user',
        idempotencyKey: '004o-event-exercise',
      },
    ],
  });
  const result = await processor.processUserMessage(
    'anon:004o-event-user',
    '我吃了午餐，饭后又散了步。',
    {
      threadId: 'thread-004o-event',
      now: '2026-08-25T14:00:00+08:00',
    },
  );

  assert(result.recordedEvents.length === 2, '没有写入两条抽取事件');
  assert(probe.getMaxActive() === 1, '长期事件在单连接池下仍并发写入');
  assert(
    probe.getOrder().join(',') === 'start:meal,end:meal,start:exercise,end:exercise',
    '长期事件写入顺序与抽取顺序不一致',
  );
}

async function main() {
  await verifyAdviceWritesAreSequential();
  await verifyEventWritesAreSequential();
  console.log(JSON.stringify({
    batch: '004o-application-services',
    status: 'PASS',
    adviceWritesSequential: true,
    eventWritesSequential: true,
    maxConcurrentWrites: 1,
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    batch: '004o-application-services',
    status: 'FAIL',
    errorCode: error.code || 'UNKNOWN',
    message: error.message,
  }));
  process.exit(1);
});
