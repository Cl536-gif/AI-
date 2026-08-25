const userService = require('./userService');

async function prepareDueRenewalReminders({
  store,
  now = new Date().toISOString(),
  limit = 100,
} = {}) {
  return await userService.enqueueDueRenewalReminders({ now, limit }, { store });
}

async function getPendingRenewalReminders({
  store,
  now = new Date().toISOString(),
  limit = 100,
} = {}) {
  return (await userService.listPendingNotifications({ now, limit }, { store }))
    .filter((item) => item.notificationType === 'trial_renewal_day_13');
}

async function confirmRenewalReminderSent(notificationId, {
  store,
  sentAt = new Date().toISOString(),
} = {}) {
  return await userService.markNotificationSent(notificationId, { sentAt }, { store });
}

module.exports = {
  prepareDueRenewalReminders,
  getPendingRenewalReminders,
  confirmRenewalReminderSent,
};
