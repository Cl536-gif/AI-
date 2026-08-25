const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const {
  selectLongTermService,
  confirmLongTermProfile,
  activateTrialAfterOfficialPlan,
  expireTrialIfDue,
  confirmSubscription,
  canRecordLongTermEvents,
} = require('./src/services/longTermService');

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-long-term-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:11111111-1111-4111-8111-111111111111';

  const selected = await selectLongTermService(userId, {
    store,
    now: '2026-08-05T10:00:00+08:00',
  });
  assert(selected.status === 'onboarding_incomplete', '选择长期方案后状态错误');
  assert(selected.trialStartedAt === null, '选择长期方案时错误启动了14天');
  assert(!await canRecordLongTermEvents(userId, { store, now: '2026-08-05T11:00:00+08:00' }), '未完成建档就允许长期记录');

  await expectError(() => activateTrialAfterOfficialPlan(userId, 'plan-too-early', {
    store,
    now: '2026-08-05T12:00:00+08:00',
  }), /不允许/, '档案未确认就启动了体验');

  const confirmed = await confirmLongTermProfile(userId, {
    store,
    now: '2026-08-05T13:00:00+08:00',
  });
  assert(confirmed.status === 'profile_confirmed', '档案确认状态错误');
  assert(confirmed.trialStartedAt === null, '仅确认档案就错误启动了体验');

  const trial = await activateTrialAfterOfficialPlan(userId, 'official-plan-v1', {
    store,
    now: '2026-08-05T15:00:00+08:00',
  });
  assert(trial.status === 'trial_active', '正式方案发出后没有启动体验');
  assert(trial.trialStartedAt === '2026-08-05T07:00:00.000Z', '体验开始时间错误');
  assert(trial.renewalReminderAt === '2026-08-18T07:00:00.000Z', '第13天提醒时间错误');
  assert(trial.trialEndsAt === '2026-08-19T07:00:00.000Z', '14天结束时间错误');
  assert(await canRecordLongTermEvents(userId, { store, now: '2026-08-10T15:00:00+08:00' }), '体验期间没有长期记录权限');

  await expectError(() => confirmSubscription(userId, '', { store }), /没有明确支付确认/, '没有支付确认仍开通订阅');

  const expired = await expireTrialIfDue(userId, {
    store,
    now: '2026-08-19T15:00:01+08:00',
  });
  assert(expired.status === 'trial_expired', '14天结束后没有过期');
  assert(!await canRecordLongTermEvents(userId, { store, now: '2026-08-19T15:01:00+08:00' }), '体验过期后仍允许长期记录');

  const subscribed = await confirmSubscription(userId, 'payment-test-001', {
    store,
    now: '2026-08-19T16:00:00+08:00',
  });
  assert(subscribed.status === 'subscribed', '支付确认后没有开通订阅');
  assert(await canRecordLongTermEvents(userId, { store, now: '2026-08-20T10:00:00+08:00' }), '正式订阅没有长期记录权限');

  const transitions = store.listServiceTransitions(userId);
  assert(transitions.length === 5, '服务状态变更历史数量错误');
  assert(transitions[0].toStatus === 'subscribed', '最新服务状态历史错误');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 选择长期方案和完善档案都不会提前启动14天');
  console.log('✅ 第一份正式长期方案发出后才精确启动14天');
  console.log('✅ 第13天提醒和第14天结束时间正确');
  console.log('✅ 未明确支付不得自动开通正式订阅');
  console.log('✅ 只有体验中或已订阅用户可以持续记录事件');
  console.log('✅ 服务状态变更保留完整历史');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
