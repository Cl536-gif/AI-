const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const {
  claimGuestDataForAuthenticatedAccount,
  getGuestMergeForAuthenticatedAccount,
  getMergeReviewForAuthenticatedAccount,
  authorizeMergedMenstrualHistory,
} = require('./src/services/accountMergeService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectError(action, pattern, message) {
  let matched = false;
  try { await action(); } catch (err) { matched = pattern.test(err.message); }
  assert(matched, message);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-account-merge-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const deviceHash = crypto.createHash('sha256').update('test-device-merge').digest('hex');
  const guestId = store.resolveAnonymousIdentity(deviceHash, { now: '2026-08-05T09:00:00+08:00' });
  const accountId = 'account-test-001';
  const targetId = `acct:${accountId}`;

  store.updateProfile(targetId, {
    body: { currentWeightKg: 70 },
    diet: { scene: 'takeaway', tastePreferences: ['清淡'] },
  }, { now: '2026-06-20T10:00:00+08:00' });
  store.updateProfile(guestId, {
    body: { heightCm: 165, currentWeightKg: 65 },
    diet: { scene: 'cafeteria', restrictions: ['酸奶后腹泻'] },
  }, { now: '2026-08-05T10:00:00+08:00' });

  store.appendEvent({
    userId: targetId,
    eventType: 'meal',
    occurredAt: '2026-08-05T12:00:00+08:00',
    payload: { foods: ['米饭'] },
    idempotencyKey: 'same-meal-001',
  });
  store.appendEvent({
    userId: guestId,
    eventType: 'meal',
    occurredAt: '2026-08-05T12:00:00+08:00',
    payload: { foods: ['米饭'] },
    idempotencyKey: 'same-meal-001',
  });
  store.appendEvent({
    userId: guestId,
    eventType: 'exercise',
    occurredAt: '2026-08-05T18:00:00+08:00',
    payload: { type: '跑步', durationMinutes: 30 },
    idempotencyKey: 'guest-run-001',
  });
  store.appendEvent({
    userId: guestId,
    eventType: 'menstrual_period_start',
    occurredAt: '2026-08-01T08:00:00+08:00',
    payload: { rawText: '8月1日开始' },
    idempotencyKey: 'guest-sensitive-001',
  });

  await expectError(
    () => claimGuestDataForAuthenticatedAccount(guestId, { accountId, isAuthenticated: false }, { store }),
    /已验证的登录会话/,
    '未认证请求能够合并游客档案'
  );

  const authContext = { accountId, isAuthenticated: true };
  const merged = await claimGuestDataForAuthenticatedAccount(guestId, authContext, {
    store,
    now: '2026-08-05T20:00:00+08:00',
  });
  assert(merged.targetUserId === targetId && merged.status === 'completed', '合并结果错误');
  assert(store.resolveAnonymousIdentity(deviceHash, { now: '2026-08-05T20:01:00+08:00' }) === targetId, '当前设备没有关联到正式账号');

  const profile = store.getProfile(targetId).profile;
  assert(profile.body.currentWeightKg === 70, '游客冲突值覆盖了正式账号');
  assert(profile.body.heightCm === 165, '游客非冲突字段没有补入正式账号');
  assert(profile.diet.restrictions.includes('酸奶后腹泻'), '游客空缺补充信息丢失');
  const review = await getMergeReviewForAuthenticatedAccount(merged.mergeId, authContext, { store });
  assert(review.conflicts.some((item) => item.fieldPath === 'body.currentWeightKg'), '体重冲突没有进入待审记录');
  assert(review.conflicts.some((item) => item.accountStaleOver30Days), '超过30天的正式档案冲突没有标记');
  assert(review.eventAudit.filter((item) => item.action === 'deduplicated').length === 1, '重复事件没有留下去重审计');
  assert(review.eventAudit.filter((item) => item.action === 'migrated_restricted').length === 1, '敏感事件没有以受限状态迁移');
  assert(store.listEvents(targetId).some((event) => event.eventType === 'exercise'), '普通游客事件没有迁移');
  assert(!store.listEvents(targetId).some((event) => event.eventType === 'menstrual_period_start'), '未重新授权就暴露了敏感历史');
  assert(store.getLatestConsent(targetId, 'menstrual_tracking') === null, '游客授权被错误继承');
  assert(
    (await getGuestMergeForAuthenticatedAccount(guestId, authContext, { store })).mergeId === merged.mergeId,
    '已认证目标账号无法读取自己的合并结果'
  );
  assert(
    await getGuestMergeForAuthenticatedAccount(guestId, {
      accountId: 'other-account', isAuthenticated: true,
    }, { store }) === null,
    '其他账号能读取不属于自己的合并结果'
  );
  assert(
    await getMergeReviewForAuthenticatedAccount(merged.mergeId, {
      accountId: 'other-account', isAuthenticated: true,
    }, { store }) === null,
    '其他账号能读取不属于自己的合并审核'
  );

  await expectError(
    () => store.updateProfile(guestId, { body: { currentWeightKg: 64 } }),
    /已合并/,
    '合并后的游客身份仍能写入新档案'
  );
  const repeated = await claimGuestDataForAuthenticatedAccount(guestId, authContext, { store });
  assert(repeated.mergeId === merged.mergeId, '重复合并没有返回幂等结果');

  const released = await authorizeMergedMenstrualHistory(targetId, merged.mergeId, authContext, {
    store,
    now: '2026-08-05T20:10:00+08:00',
  });
  assert(released === 1, '重新授权后没有释放迁移的敏感历史');
  assert(store.listEvents(targetId).some((event) => event.eventType === 'menstrual_period_start'), '重新授权后仍无法读取敏感历史');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 只有后端已认证登录会话可以认领游客档案');
  console.log('✅ 正式档案优先，游客只补空缺，冲突进入待审并标记时效');
  console.log('✅ 普通事件迁移去重且保留哈希审计');
  console.log('✅ 敏感历史迁移后保持受限，重新授权后才可使用');
  console.log('✅ 设备改为关联正式账号，旧游客身份锁定且重复合并幂等');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});
