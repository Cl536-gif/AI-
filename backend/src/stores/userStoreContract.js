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
  'getUserDataSnapshot',
  'getUserSettings',
  'updateUserTimezone',
  'recordConsent',
  'getLatestConsent',
]);

// Cross-user directory reads are deliberately kept out of the production
// UserStore port. They require an explicit administrative authentication and
// audit boundary before a non-SQLite adapter may implement them.
const USER_STORE_ADMIN_METHODS = Object.freeze([
  'listUserSummaries',
]);

function getMissingMethods(store, methodNames) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) {
    return [...methodNames];
  }
  return methodNames.filter((methodName) => typeof store[methodName] !== 'function');
}

function getMissingUserStoreMethods(store) {
  return getMissingMethods(store, USER_STORE_METHODS);
}

function getMissingUserStoreAdminMethods(store) {
  return getMissingMethods(store, USER_STORE_ADMIN_METHODS);
}

function assertUserStore(store, { adapterName = 'UserStore' } = {}) {
  const missingMethods = getMissingUserStoreMethods(store);
  if (missingMethods.length > 0) {
    throw new TypeError(`${adapterName} 缺少 UserStore 方法：${missingMethods.join(', ')}`);
  }
  return store;
}

function assertUserStoreAdmin(store, { adapterName = 'UserStoreAdmin' } = {}) {
  const missingMethods = getMissingUserStoreAdminMethods(store);
  if (missingMethods.length > 0) {
    throw new TypeError(`${adapterName} 缺少管理端 UserStore 方法：${missingMethods.join(', ')}`);
  }
  return store;
}

module.exports = {
  USER_STORE_METHODS,
  USER_STORE_ADMIN_METHODS,
  getMissingUserStoreMethods,
  getMissingUserStoreAdminMethods,
  assertUserStore,
  assertUserStoreAdmin,
};
