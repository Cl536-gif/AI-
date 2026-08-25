const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { recordUserEvent, recordUserConsent } = require('./src/services/userDataService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectError(action, pattern, message) {
  let matched = false;
  try {
    await action();
  } catch (err) {
    matched = pattern.test(err.message);
  }
  assert(matched, message);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-user-data-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:11111111-1111-4111-8111-111111111111';
  const otherUserId = 'anon:22222222-2222-4222-8222-222222222222';

  const meal = await recordUserEvent(userId, {
    eventType: 'meal',
    occurredAt: '2026-08-05T12:00:00+08:00',
    payload: { mealType: 'lunch', foods: ['米饭', '西兰花'], rawText: '中午吃了米饭和西兰花' },
    idempotencyKey: 'thread-1-message-8-meal',
  }, { store, recordedAt: '2026-08-05T12:05:00+08:00' });
  const sameMeal = await recordUserEvent(userId, {
    eventType: 'meal',
    occurredAt: '2026-08-05T12:00:00+08:00',
    payload: { mealType: 'lunch', foods: ['米饭', '西兰花'] },
    idempotencyKey: 'thread-1-message-8-meal',
  }, { store, recordedAt: '2026-08-05T12:06:00+08:00' });
  assert(meal.eventId === sameMeal.eventId, '业务层重试产生了重复事件');

  await recordUserEvent(userId, {
    eventType: 'snack',
    occurredAt: '2026-08-05T15:00:00+08:00',
    payload: { food: '饼干', amountText: '两片' },
  }, { store });
  await recordUserEvent(userId, {
    eventType: 'exercise',
    occurredAt: '2026-08-05T18:00:00+08:00',
    payload: { activity: '跑步', durationMinutes: 30, deviceEstimatedKcal: 260 },
  }, { store });
  await recordUserEvent(userId, {
    eventType: 'plan_interruption',
    occurredAt: '2026-08-06T08:00:00+08:00',
    payload: { reason: '旅行三天', rawText: '接下来出去玩三天' },
  }, { store });
  assert(store.listEvents(userId).length === 4, '普通长期事件没有完整保存');

  await expectError(() => recordUserEvent(userId, {
    eventType: 'menstrual_period_start',
    occurredAt: '2026-08-05T08:00:00+08:00',
    payload: { date: '2026-08-05' },
  }, { store }), /缺少当前有效/, '未授权经期事件没有被拒绝');

  await recordUserConsent(userId, {
    consentType: 'menstrual_tracking',
    status: 'granted',
    recordedAt: '2026-08-05T09:00:00+08:00',
  }, { store });
  const period = await recordUserEvent(userId, {
    eventType: 'menstrual_period_start',
    occurredAt: '2026-08-05T08:00:00+08:00',
    payload: { date: '2026-08-05', rawText: '今天来了' },
  }, { store });
  assert(period.eventType === 'menstrual_period_start', '授权后经期事件仍无法写入');

  await recordUserConsent(userId, {
    consentType: 'menstrual_tracking',
    status: 'revoked',
    recordedAt: '2026-08-05T10:00:00+08:00',
  }, { store });
  await expectError(() => recordUserEvent(userId, {
    eventType: 'menstrual_symptom',
    occurredAt: '2026-08-05T11:00:00+08:00',
    payload: { symptom: '疲劳' },
  }, { store }), /缺少当前有效/, '撤回授权后仍能写入经期事件');

  await expectError(() => recordUserEvent(otherUserId, {
    eventType: 'user_correction',
    occurredAt: '2026-08-05T12:10:00+08:00',
    payload: { correction: '不是米饭，是面条' },
    supersedesEventId: meal.eventId,
  }, { store }), /不存在或不属于/, '其他用户能够纠正当前用户的事件');

  const correction = await recordUserEvent(userId, {
    eventType: 'user_correction',
    occurredAt: '2026-08-05T12:10:00+08:00',
    payload: { correction: '不是米饭，是面条' },
    supersedesEventId: meal.eventId,
  }, { store });
  assert(correction.supersedesEventId === meal.eventId, '纠错事件没有关联旧事件');

  await expectError(() => recordUserEvent(userId, {
    userId: otherUserId,
    eventType: 'meal',
    occurredAt: '2026-08-05T20:00:00+08:00',
    payload: {},
  }, { store }), /不能自行指定userId/, '事件命令能够伪造其他用户身份');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 正餐、零食、运动和计划中断通过业务层写入');
  console.log('✅ 幂等键阻止网络重试产生重复事件');
  console.log('✅ 经期事件必须有当前有效的单独授权');
  console.log('✅ 撤回经期授权后立即阻断新增事件');
  console.log('✅ 纠错只能指向当前用户自己的旧事件');
  console.log('✅ 事件命令不能伪造其他userId');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});
