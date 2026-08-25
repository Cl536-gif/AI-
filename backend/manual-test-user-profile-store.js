const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-user-store-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'test-user-001';

  const firstActivity = store.recordActivity(userId);
  assert(firstActivity.previousActiveAt === null, '新用户的上次活跃时间应为null');
  const secondActivity = store.recordActivity(userId);
  assert(Boolean(secondActivity.previousActiveAt), '老用户应返回上次活跃时间');

  const v1 = store.updateProfile(userId, {
    body: { ageYears: 22, heightCm: 165, currentWeightKg: 60 },
    diet: { scene: 'cafeteria', tastePreferences: ['酸甜'] },
  });
  assert(v1.profileVersion === 1, '首次档案版本应为1');
  assert(v1.profile.body.currentWeightKg === 60, '体重没有写入档案');

  const v2 = store.updateProfile(
    userId,
    { body: { currentWeightKg: 59.5 }, diet: { restrictions: ['酸奶后腹泻'] } },
    { expectedVersion: 1, source: 'user' }
  );
  assert(v2.profileVersion === 2, '第二次档案版本应为2');
  assert(v2.profile.body.heightCm === 165, '局部更新不应丢失旧身高');
  assert(v2.profile.diet.tastePreferences[0] === '酸甜', '局部更新不应丢失旧口味');
  const revisions = store.listProfileRevisions(userId);
  assert(revisions.length === 2, '档案历史版本数量错误');
  assert(revisions[0].profileVersion === 2 && revisions[1].profileVersion === 1, '档案历史版本顺序错误');
  assert(store.getProfile(userId).profileVersion === 2, '当前档案没有读取user_profiles中的最新版本');

  let conflictCaught = false;
  try {
    store.updateProfile(userId, { body: { currentWeightKg: 58 } }, { expectedVersion: 1 });
  } catch (err) {
    conflictCaught = /版本冲突/.test(err.message);
  }
  assert(conflictCaught, '过期版本更新没有被拒绝');

  const meal = store.appendEvent({
    userId,
    eventType: 'meal',
    occurredAt: '2026-08-05T12:00:00+08:00',
    recordedAt: '2026-08-05T12:10:00+08:00',
    payload: { mealType: 'lunch', foods: ['杂粮饭', '西兰花'], rawText: '中午吃了杂粮饭和西兰花' },
    idempotencyKey: 'message-100-meal-1',
  });
  const sameMeal = store.appendEvent({
    userId,
    eventType: 'meal',
    occurredAt: '2026-08-05T12:00:00+08:00',
    recordedAt: '2026-08-05T12:10:00+08:00',
    payload: { mealType: 'lunch', foods: ['杂粮饭', '西兰花'] },
    idempotencyKey: 'message-100-meal-1',
  });
  assert(meal.eventId === sameMeal.eventId, '相同幂等键产生了重复事件');

  const snack = store.appendEvent({
    userId,
    eventType: 'snack',
    occurredAt: '2026-08-05T15:00:00+08:00',
    payload: { food: '饼干', amountText: '两片' },
  });
  assert(store.listEvents(userId).length === 2, '事件数量错误');
  assert(store.listEvents(userId, { eventType: 'snack' })[0].eventId === snack.eventId, '事件类型过滤错误');

  const otherUserId = 'test-user-002';
  store.updateProfile(otherUserId, {
    body: { ageYears: 19 },
    diet: { scene: 'takeaway' },
  });
  store.appendEvent({
    userId: otherUserId,
    eventType: 'meal',
    occurredAt: '2026-08-05T18:00:00+08:00',
    payload: { mealType: 'dinner', foods: ['米饭'] },
  });
  assert(store.getProfile(userId).profile.body.ageYears === 22, '其他用户的档案污染了当前用户');
  assert(store.listEvents(userId).length === 2, '其他用户的事件污染了当前用户');
  assert(store.getEvent(otherUserId, meal.eventId) === null, '其他用户能够读取当前用户的事件');

  const consent = store.recordConsent({
    userId,
    consentType: 'long_term_profile',
    status: 'granted',
    recordedAt: '2026-08-05T10:00:00+08:00',
  });
  assert(consent.status === 'granted', '授权记录没有保存');
  const revokedConsent = store.recordConsent({
    userId,
    consentType: 'long_term_profile',
    status: 'revoked',
    recordedAt: '2026-08-05T11:00:00+08:00',
  });
  assert(revokedConsent.status === 'revoked', '撤回授权没有成为最新状态');
  assert(
    store.getLatestConsent(userId, 'long_term_profile').status === 'revoked',
    '读取授权时没有返回最新撤回状态'
  );

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 匿名用户身份与活跃时间兼容旧接口');
  console.log('✅ 档案局部更新、版本冲突和历史版本正常');
  console.log('✅ 饮食/零食事件追加、幂等去重与类型查询正常');
  console.log('✅ 不同用户的档案和事件相互隔离');
  console.log('✅ 长期档案授权追加记录与撤回状态正常');
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
