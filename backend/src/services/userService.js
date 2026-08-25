const { UserIdSchema } = require('../domain/userDataContract');
const { getUserStore } = require('../stores/userStoreProvider');
const {
  recordUserEvent,
  recordUserConsent,
} = require('./userDataService');

function resolveStore(store) {
  return store || getUserStore();
}

async function ensureUser(userId, { store, now } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).ensureUser(normalizedUserId, { now });
}

async function getProfile(userId, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).getProfile(normalizedUserId);
}

async function updateProfile(userId, patch, options = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const { store, ...commandOptions } = options;
  return await resolveStore(store).updateProfile(normalizedUserId, patch, commandOptions);
}

async function appendEvent(userId, command, options = {}) {
  const store = resolveStore(options.store);
  return await recordUserEvent(userId, command, { ...options, store });
}

async function recordConsent(userId, consent, options = {}) {
  const store = resolveStore(options.store);
  return await recordUserConsent(userId, consent, { ...options, store });
}

async function getServiceStatus(userId, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).getServiceStatus(normalizedUserId);
}

async function setServiceStatus(userId, statusPatch, options = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const { store, ...commandOptions } = options;
  return await resolveStore(store).setServiceStatus(normalizedUserId, statusPatch, commandOptions);
}

async function recordAdvice(userId, advice, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).recordAdvice(normalizedUserId, advice);
}

async function updateTimezone(userId, timezone, { store, now } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).updateUserTimezone(normalizedUserId, timezone, { now });
}

async function getUserDataSnapshot(userId, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).getUserDataSnapshot(normalizedUserId);
}

async function getUserSettings(userId, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).getUserSettings(normalizedUserId);
}

async function getLatestConsent(userId, consentType, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).getLatestConsent(normalizedUserId, consentType);
}

async function listAdviceHistory(userId, query = {}, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).listAdviceHistory(normalizedUserId, query);
}

async function listEvents(userId, query = {}, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).listEvents(normalizedUserId, query);
}

async function getActivePlan(userId, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).getActivePlan(normalizedUserId);
}

async function getPlan(userId, planId, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).getPlan(normalizedUserId, planId);
}

async function listPlans(userId, query = {}, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).listPlans(normalizedUserId, query);
}

async function listEnergyCalculations(userId, query = {}, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).listEnergyCalculations(normalizedUserId, query);
}

async function recordEnergyCalculation(userId, calculation, options = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const { store, ...commandOptions } = options;
  return await resolveStore(store).recordEnergyCalculation(normalizedUserId, calculation, commandOptions);
}

async function createPlanDraft(userId, plan, options = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const { store, ...commandOptions } = options;
  return await resolveStore(store).createPlanDraft(normalizedUserId, plan, commandOptions);
}

async function transitionPlan(userId, planId, targetStatus, options = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  const { store, ...commandOptions } = options;
  return await resolveStore(store).transitionPlan(normalizedUserId, planId, targetStatus, commandOptions);
}

async function activateInitialPlanAndTrial(userId, planId, trial, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).activateInitialPlanAndTrial(normalizedUserId, planId, trial);
}

async function getPlanRevisionCommand(userId, commandId, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).getPlanRevisionCommand(normalizedUserId, commandId);
}

async function recordPlanRevisionCommand(userId, commandId, command, { store } = {}) {
  const normalizedUserId = UserIdSchema.parse(userId);
  return await resolveStore(store).recordPlanRevisionCommand(normalizedUserId, commandId, command);
}

async function enqueueDueRenewalReminders(query = {}, { store } = {}) {
  return await resolveStore(store).enqueueDueRenewalReminders(query);
}

async function listPendingNotifications(query = {}, { store } = {}) {
  return await resolveStore(store).listPendingNotifications(query);
}

async function markNotificationSent(notificationId, command = {}, { store } = {}) {
  return await resolveStore(store).markNotificationSent(notificationId, command);
}

module.exports = {
  ensureUser,
  getProfile,
  updateProfile,
  appendEvent,
  recordConsent,
  getServiceStatus,
  setServiceStatus,
  recordAdvice,
  updateTimezone,
  getUserDataSnapshot,
  getUserSettings,
  getLatestConsent,
  listAdviceHistory,
  listEvents,
  getActivePlan,
  getPlan,
  listPlans,
  listEnergyCalculations,
  recordEnergyCalculation,
  createPlanDraft,
  transitionPlan,
  activateInitialPlanAndTrial,
  getPlanRevisionCommand,
  recordPlanRevisionCommand,
  enqueueDueRenewalReminders,
  listPendingNotifications,
  markNotificationSent,
};
