const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { buildLongTermTimeline } = require('./src/services/longTermTimelineService');
const { buildGreetingMessages } = require('./src/services/chatService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-timeline-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:99999999-9999-4999-8999-999999999999';
  const start = '2026-08-01T00:00:00+08:00';
  store.setServiceStatus(userId, {
    status: 'trial_active', trialStartedAt: start,
    trialEndsAt: '2026-08-15T10:00:00+08:00',
    renewalReminderAt: '2026-08-14T10:00:00+08:00',
    officialPlanId: 'plan-test',
  }, { reason: 'test', now: start });

  const day2 = await buildLongTermTimeline(userId, {
    store, now: '2026-08-02T09:00:00+08:00',
  });
  assert(day2.planDay === 2, '没有按上海自然日计算第2天');
  assert(day2.dueCheckIn === 'day_2_meal_feedback', '第2天没有触发餐后反馈');
  const day2Greeting = buildGreetingMessages(start, Date.parse('2026-08-02T09:00:00+08:00'), {
    longTermTimeline: day2,
  }).join('\n');
  assert(/分量够不够/.test(day2Greeting) && !/体重/.test(day2Greeting), '第2天问法不符合规则');

  store.appendEvent({
    userId, eventType: 'check_in', occurredAt: '2026-08-02T12:00:00+08:00',
    payload: { summary: '分量合适' }, idempotencyKey: 'day2-check-in',
  });
  const day2Done = await buildLongTermTimeline(userId, {
    store, now: '2026-08-02T13:00:00+08:00',
  });
  assert(day2Done.dueCheckIn === null, '完成第2天反馈后仍重复追问');

  const day8 = await buildLongTermTimeline(userId, {
    store, now: '2026-08-08T09:00:00+08:00',
  });
  assert(day8.planDay === 8, '第8天计算错误');
  assert(day8.dueCheckIn === 'weekly_review', '完整7天后没有触发周复盘');
  const weeklyGreeting = buildGreetingMessages(start, Date.parse('2026-08-08T09:00:00+08:00'), {
    longTermTimeline: day8,
  }).join('\n');
  assert(/这周/.test(weeklyGreeting) && /同一台秤/.test(weeklyGreeting), '周复盘没有邀请标准化称重');

  store.setServiceStatus(userId, {
    status: 'subscribed', trialStartedAt: start,
    trialEndsAt: '2026-08-15T10:00:00+08:00',
    renewalReminderAt: '2026-08-14T10:00:00+08:00', officialPlanId: 'plan-test',
  }, { reason: 'test-subscription', now: '2026-08-15T10:00:00+08:00' });
  [['2026-08-01T08:00:00+08:00', 60], ['2026-08-08T08:00:00+08:00', 59.9],
    ['2026-08-15T08:00:00+08:00', 60.1], ['2026-08-22T08:00:00+08:00', 60]].forEach(([occurredAt, weightKg], index) => {
    store.appendEvent({
      userId, eventType: 'body_measurement', occurredAt,
      payload: { summary: `体重${weightKg}公斤`, weightKg }, idempotencyKey: `weight-${index}`,
    });
  });
  const plateau = await buildLongTermTimeline(userId, {
    store, now: '2026-08-22T10:00:00+08:00',
  });
  assert(plateau.weightTrend.status === 'possible_plateau', '连续3周稳定体重没有进入候选核查');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
console.log('PASS: 第2天回访、首次周复盘、避免重复追问和平台期候选规则均通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
