const { createGraphEventExtractor } = require('./src/services/graphEventExtractionService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createStubModel(results) {
  let index = 0;
  return {
    withStructuredOutput() {
      return {
        async invoke() {
          return results[index++];
        },
      };
    },
  };
}

async function main() {
  const model = createStubModel([
    {
      events: [
        {
          eventType: 'meal',
          occurredAt: '2026-08-05T12:30:00+08:00',
          summary: '午餐吃了米饭和鸡腿',
          mealType: 'lunch',
          amountText: '一碗米饭和一个鸡腿',
          durationMinutes: null,
          deviceEstimatedKcal: null,
          weightKg: null,
          reason: null,
        },
        {
          eventType: 'exercise',
          occurredAt: '2026-08-05T18:00:00+08:00',
          summary: '跑步30分钟',
          mealType: null,
          amountText: null,
          durationMinutes: 30,
          deviceEstimatedKcal: 260,
          weightKg: null,
          reason: null,
        },
      ],
    },
    { events: [] },
    { events: [] },
    {
      events: [{
        eventType: 'plan_interruption',
        occurredAt: '2026-08-06T08:00:00+08:00',
        summary: '已经确定出差三天',
        mealType: null,
        amountText: null,
        durationMinutes: null,
        deviceEstimatedKcal: null,
        weightKg: null,
        reason: '出差三天',
      }],
    },
  ]);
  const extractor = createGraphEventExtractor({ model });
  const options = {
    threadId: 'thread-test-001',
    now: '2026-08-05T20:00:00+08:00',
  };

  const actualEvents = await extractor.extract('中午吃了一碗米饭和一个鸡腿，晚上跑了30分钟，手表显示260千卡', options);
  assert(actualEvents.length === 2, '一条消息里的多个实际事件没有分别提取');
  assert(actualEvents[0].payload.rawText.includes('中午吃了'), '事件没有保留用户原话');
  assert(actualEvents[1].payload.deviceEstimatedKcal === 260, '设备估算消耗没有作为参考值保存');
  assert(actualEvents[0].idempotencyKey !== actualEvents[1].idempotencyKey, '同一消息多个事件幂等键冲突');

  const questionEvents = await extractor.extract('明天早餐可以吃鸡蛋吗？', options);
  assert(questionEvents.length === 0, '饮食问题被误记成已经发生的正餐');

  const onboardingEvents = await extractor.extract('22岁，165厘米，当前60公斤，目标55公斤', options);
  assert(onboardingEvents.length === 0, '建档身体数据被误记成日常测量事件');

  const interruptionEvents = await extractor.extract('已经确定明天开始出差三天，这几天计划会被打乱', options);
  assert(interruptionEvents.length === 1 && interruptionEvents[0].eventType === 'plan_interruption', '明确计划中断没有提取');

  const repeatedEvents = await createGraphEventExtractor({
    model: createStubModel([{
      events: [{
        eventType: 'meal',
        occurredAt: '2026-08-05T12:30:00+08:00',
        summary: '午餐吃了米饭和鸡腿',
        mealType: 'lunch',
        amountText: null,
        durationMinutes: null,
        deviceEstimatedKcal: null,
        weightKg: null,
        reason: null,
      }],
    }]),
  }).extract('中午吃了一碗米饭和一个鸡腿，晚上跑了30分钟，手表显示260千卡', options);
  assert(repeatedEvents[0].idempotencyKey === actualEvents[0].idempotencyKey, '相同消息重试没有生成稳定幂等键');

  console.log('✅ 一条消息可提取多个已经发生的事件');
  console.log('✅ 用户原话和设备估算消耗保留为审计参考');
  console.log('✅ 饮食问题和未来打算不会误记成实际事件');
  console.log('✅ 建档身体数据不会误记成日常测量');
  console.log('✅ 明确的计划中断能够形成事件');
  console.log('✅ 相同消息重试生成稳定幂等键');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
