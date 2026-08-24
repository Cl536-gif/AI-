/**
 * UserStore port used by the business layer.
 *
 * Storage adapters may return either a value or a Promise while the project is
 * being migrated. Business-layer callers must `await` store results so the same
 * contract can support both the current synchronous SQLite adapter and the
 * future asynchronous Supabase-compatible adapter.
 */

const USER_STORE_METHODS = Object.freeze([
  'ensureUser',
  'recordActivity',
  'resolveAnonymousIdentity',
  'getServiceStatus',
  'setServiceStatus',
  'listServiceTransitions',
  'getUserMerge',
  'mergeAnonymousIntoAccount',
  'getMergeReview',
  'releaseMergedSensitiveEvents',
  'recordEnergyCalculation',
  'listEnergyCalculations',
  'createPlanDraft',
  'getPlan',
  'getActivePlan',
  'listPlans',
  'transitionPlan',
  'activateInitialPlanAndTrial',
  'listPlanTransitions',
  'getPlanRevisionCommand',
  'recordPlanRevisionCommand',
  'enqueueDueRenewalReminders',
  'listPendingNotifications',
  'markNotificationSent',
  'getProfile',
  'updateProfile',
  'listProfileRevisions',
  'appendEvent',
  'getEvent',
  'listEvents',
  'recordAdvice',
  'listAdviceHistory',
  'listUserSummaries',
  'getUserDataSnapshot',
  'getUserSettings',
  'updateUserTimezone',
  'recordConsent',
  'getLatestConsent',
]);

function getMissingUserStoreMethods(store) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) {
    return [...USER_STORE_METHODS];
  }
  return USER_STORE_METHODS.filter((methodName) => typeof store[methodName] !== 'function');
}

function assertUserStore(store, { adapterName = 'UserStore' } = {}) {
  const missingMethods = getMissingUserStoreMethods(store);
  if (missingMethods.length > 0) {
    throw new TypeError(`${adapterName} 缺少 UserStore 方法：${missingMethods.join(', ')}`);
  }
  return store;
}

module.exports = {
  USER_STORE_METHODS,
  getMissingUserStoreMethods,
  assertUserStore,
};
