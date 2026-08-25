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
const {
  prepareDueRenewalReminders,
  getPendingRenewalReminders,
  confirmRenewalReminderSent,
} = require('./src/services/renewalReminderService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function activateTrial(store, userId) {
  await selectLongTermService(userId, { store, now: '2026-08-05T15:00:00+08:00' });
  await confirmLongTermProfile(userId, { store, now: '2026-08-05T15:05:00+08:00' });
  return await activateTrialAfterOfficialPlan(userId, 'official-plan-reminder-001', {
    store,
    now: '2026-08-05T15:10:00+08:00',
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-reminder-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:33333333-3333-4333-8333-333333333333';
  const trial = await activateTrial(store, userId);

  const early = await prepareDueRenewalReminders({
    store,
    now: '2026-08-18T07:09:59.000Z',
  });
  assert(early.length === 0, '第13天提醒时间前错误创建提醒');

  const due = await prepareDueRenewalReminders({ store, now: trial.renewalReminderAt });
  assert(due.length === 1, '第13天到点没有创建提醒');
  assert(due[0].status === 'pending', '新提醒不是待发送状态');

  const repeated = await prepareDueRenewalReminders({
    store,
    now: '2026-08-18T08:00:00.000Z',
  });
  assert(repeated.length === 1, '重复调度没有返回同一提醒');
  assert(repeated[0].notificationId === due[0].notificationId, '重复调度创建了第二条提醒');

  const pending = await getPendingRenewalReminders({ store, now: '2026-08-18T08:00:00.000Z' });
  assert(pending.length === 1, '待发送提醒数量错误');
  assert(await confirmRenewalReminderSent(pending[0].notificationId, {
    store,
    sentAt: '2026-08-18T08:01:00.000Z',
  }), '首次确认发送失败');
  assert(!await confirmRenewalReminderSent(pending[0].notificationId, {
    store,
    sentAt: '2026-08-18T08:02:00.000Z',
  }), '同一提醒被重复确认发送');
  assert((await getPendingRenewalReminders({ store, now: '2026-08-18T09:00:00.000Z' })).length === 0, '已发送提醒仍出现在待发送队列');

  const expiredUser = 'anon:44444444-4444-4444-8444-444444444444';
  await activateTrial(store, expiredUser);
  await expireTrialIfDue(expiredUser, { store, now: '2026-08-19T07:10:01.000Z' });
  const afterExpiry = await prepareDueRenewalReminders({ store, now: '2026-08-19T07:11:00.000Z' });
  assert(!afterExpiry.some((item) => item.userId === expiredUser), '体验到期后仍创建续费提醒');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 第13天之前不会创建续费提醒');
  console.log('✅ 到点创建唯一待发送提醒，重复调度不会产生重复记录');
  console.log('✅ 成功发送后不会再次进入发送队列');
  console.log('✅ 体验已到期的用户不会再创建提醒');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
