const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const {
  selectLongTermService,
  confirmLongTermProfile,
  activateTrialAfterOfficialPlan,
  expireTrialIfDue,
} = require('./src/services/longTermService');
const { createLongTermEventProcessor } = require('./src/services/longTermEventService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-long-term-events-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:22222222-2222-4222-8222-222222222222';
  let extractorCalls = 0;
  const processor = createLongTermEventProcessor({
    store,
    extractEvents: async (message) => {
      extractorCalls += 1;
      return [{
        eventType: 'meal',
        occurredAt: '2026-08-05T12:30:00+08:00',
        payload: { summary: '午餐吃了米饭和鸡腿', rawText: message },
        source: 'user',
        idempotencyKey: 'gated-event-001',
      }];
    },
  });

  const freeResult = await processor.processUserMessage(userId, '午餐吃了米饭和鸡腿', {
    threadId: 'thread-gate-001',
    now: '2026-08-05T12:40:00+08:00',
  });
  assert(freeResult.status === 'not_entitled', '免费用户没有被权限闸门阻断');
  assert(extractorCalls === 0, '免费用户消息仍调用了事件抽取模型');
  assert(store.listEvents(userId).length === 0, '免费用户产生了长期事件');

  await selectLongTermService(userId, { store, now: '2026-08-05T13:00:00+08:00' });
  await confirmLongTermProfile(userId, { store, now: '2026-08-05T13:10:00+08:00' });
  const beforeTrial = await processor.processUserMessage(userId, '晚餐吃了米饭', {
    threadId: 'thread-gate-001',
    now: '2026-08-05T13:20:00+08:00',
  });
  assert(beforeTrial.status === 'not_entitled', '仅完成建档就允许长期记录');
  assert(extractorCalls === 0, '体验开始前仍调用了事件抽取模型');

  await activateTrialAfterOfficialPlan(userId, 'official-plan-gate-001', {
    store,
    now: '2026-08-05T14:00:00+08:00',
  });
  const activeResult = await processor.processUserMessage(userId, '午餐吃了米饭和鸡腿', {
    threadId: 'thread-gate-001',
    now: '2026-08-05T14:10:00+08:00',
  });
  assert(activeResult.status === 'recorded', '体验开始后没有进入事件记录链');
  assert(extractorCalls === 1, '体验开始后事件抽取调用次数错误');
  assert(activeResult.recordedEvents.length === 1, '体验期间没有写入提取出的事件');
  assert(store.listEvents(userId).length === 1, '体验期间事件未落库');

  await expireTrialIfDue(userId, { store, now: '2026-08-19T14:00:01+08:00' });
  const expiredResult = await processor.processUserMessage(userId, '晚餐吃了面条', {
    threadId: 'thread-gate-001',
    now: '2026-08-19T14:10:00+08:00',
  });
  assert(expiredResult.status === 'not_entitled', '体验到期后仍允许新增事件');
  assert(extractorCalls === 1, '体验到期后仍调用了事件抽取模型');
  assert(store.listEvents(userId).length === 1, '体验到期后仍写入了事件');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 免费用户和建档中用户不会调用事件抽取模型');
  console.log('✅ 只有正式体验开始后才抽取并写入长期事件');
  console.log('✅ 体验到期后立即停止抽取与新增事件');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
