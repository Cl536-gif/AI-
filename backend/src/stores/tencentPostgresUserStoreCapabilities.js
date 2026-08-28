const { USER_STORE_METHODS } = require('./userStoreContract');

const IMPLEMENTED_AND_VERIFIED_METHODS = Object.freeze([
  'ensureUser',
  'resolveAnonymousIdentity',
  'mergeAnonymousIntoAccount',
  'getUserMerge',
  'getMergeReview',
  'releaseMergedSensitiveEvents',
  'getProfile',
  'updateProfile',
  'listProfileRevisions',
  'recordActivity',
  'getUserSettings',
  'updateUserTimezone',
  'getServiceStatus',
  'setServiceStatus',
  'listServiceTransitions',
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
  'recordAdvice',
  'listAdviceHistory',
  'getUserDataSnapshot',
  'appendEvent',
  'getEvent',
  'listEvents',
  'recordConsent',
  'getLatestConsent',
]);

// Backward-compatible implementation inventory used by TencentPostgresUserStore.
// The 37 methods above were promoted only after the 005m evidence matrix and all
// referenced acceptance manifests passed the final go/no-go integrity audit.
const DATABASE_READY_METHODS = IMPLEMENTED_AND_VERIFIED_METHODS;

const SCHEMA_REQUIRED_METHODS = Object.freeze([
]);

const CONTRACT_CHANGE_REQUIRED_METHODS = Object.freeze([]);

const METHOD_CAPABILITIES = Object.freeze(Object.fromEntries([
  ...IMPLEMENTED_AND_VERIFIED_METHODS.map((methodName) => [
    methodName,
    'implemented_and_verified',
  ]),
  ...SCHEMA_REQUIRED_METHODS.map((methodName) => [methodName, 'schema_required']),
  ...CONTRACT_CHANGE_REQUIRED_METHODS.map((methodName) => [methodName, 'contract_change_required']),
]));

function getCapabilityInventory() {
  return USER_STORE_METHODS.map((methodName) => ({
    methodName,
    status: METHOD_CAPABILITIES[methodName] || 'unclassified',
  }));
}

function assertCompleteCapabilityInventory() {
  const inventory = getCapabilityInventory();
  const unknownMethods = Object.keys(METHOD_CAPABILITIES)
    .filter((methodName) => !USER_STORE_METHODS.includes(methodName));
  const unclassifiedMethods = inventory
    .filter(({ status }) => status === 'unclassified')
    .map(({ methodName }) => methodName);

  if (unknownMethods.length > 0 || unclassifiedMethods.length > 0) {
    throw new Error(
      `TencentPostgres UserStore 能力清单不完整：unknown=${unknownMethods.join(',') || 'none'}; ` +
      `unclassified=${unclassifiedMethods.join(',') || 'none'}`
    );
  }
  return inventory;
}

function isTencentPostgresCutoverReady() {
  const inventory = assertCompleteCapabilityInventory();
  return inventory.every(({ status }) => status === 'implemented_and_verified');
}

module.exports = {
  IMPLEMENTED_AND_VERIFIED_METHODS,
  DATABASE_READY_METHODS,
  SCHEMA_REQUIRED_METHODS,
  CONTRACT_CHANGE_REQUIRED_METHODS,
  METHOD_CAPABILITIES,
  getCapabilityInventory,
  assertCompleteCapabilityInventory,
  isTencentPostgresCutoverReady,
};
