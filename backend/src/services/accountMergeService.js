const userStore = require('./userStore');

function requireAuthenticatedAccount(authContext) {
  if (!authContext || authContext.isAuthenticated !== true ||
      typeof authContext.accountId !== 'string' || !authContext.accountId.trim()) {
    throw new Error('必须通过后端已验证的登录会话才能合并游客档案');
  }
  return authContext.accountId.trim();
}

function claimGuestDataForAuthenticatedAccount(sourceAnonymousUserId, authContext, {
  store = userStore,
  now = new Date().toISOString(),
} = {}) {
  const accountId = requireAuthenticatedAccount(authContext);
  return store.mergeAnonymousIntoAccount(sourceAnonymousUserId, accountId, { now });
}

function getGuestMergeForAuthenticatedAccount(sourceAnonymousUserId, authContext, {
  store = userStore,
} = {}) {
  const accountId = requireAuthenticatedAccount(authContext);
  return store.getUserMerge(`acct:${accountId}`, sourceAnonymousUserId);
}

function getMergeReviewForAuthenticatedAccount(mergeId, authContext, {
  store = userStore,
} = {}) {
  const accountId = requireAuthenticatedAccount(authContext);
  return store.getMergeReview(`acct:${accountId}`, mergeId);
}

async function authorizeMergedMenstrualHistory(userId, mergeId, authContext, {
  store = userStore,
  now = new Date().toISOString(),
} = {}) {
  const accountId = requireAuthenticatedAccount(authContext);
  if (userId !== `acct:${accountId}`) throw new Error('登录账号与目标档案不一致');
  await store.recordConsent({
    userId,
    consentType: 'menstrual_tracking',
    status: 'granted',
    recordedAt: now,
    source: 'user',
  });
  return await store.releaseMergedSensitiveEvents(userId, mergeId);
}

module.exports = {
  requireAuthenticatedAccount,
  claimGuestDataForAuthenticatedAccount,
  getGuestMergeForAuthenticatedAccount,
  getMergeReviewForAuthenticatedAccount,
  authorizeMergedMenstrualHistory,
};
