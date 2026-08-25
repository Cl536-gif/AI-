const assert = require('assert');
const {
  createTencentPostgresUserStore,
} = require('./src/stores/tencentPostgresUserStore');

const notificationId = 'notification-004j-local';
const userId = 'acct:004j_local_store';
const calls = [];

const rpcNotification = {
  notificationId,
  userId,
  notificationType: 'trial_renewal_day_13',
  dedupeKey: 'renewal-day-13:2026-08-01T00:00:00+00:00',
  scheduledAt: '2026-08-14T00:00:00+00:00',
  status: 'pending',
  attempts: 0,
  createdAt: '2026-08-14T00:00:00+00:00',
  sentAt: null,
};

const client = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('enqueue_due_renewal_reminders')) {
      return { rows: [{ result: JSON.stringify([rpcNotification]) }] };
    }
    if (sql.includes('list_pending_notifications')) {
      return { rows: [{ result: [rpcNotification] }] };
    }
    if (sql.includes('mark_notification_sent')) {
      return { rows: [{ result: true }] };
    }
    throw new Error(`未覆盖的本地SQL：${sql}`);
  },
};

const store = createTencentPostgresUserStore({
  async runUserTransaction(_userId, callback) {
    return callback(client);
  },
  async runPostgresClient(callback) {
    return callback(client);
  },
});

async function run() {
  const enqueued = await store.enqueueDueRenewalReminders({
    now: '2026-08-14T08:00:00+08:00',
    limit: 999,
  });
  assert.strictEqual(enqueued.length, 1);
  assert.deepStrictEqual(enqueued[0], {
    ...rpcNotification,
    scheduledAt: '2026-08-14T00:00:00.000Z',
    createdAt: '2026-08-14T00:00:00.000Z',
  });

  const pending = await store.listPendingNotifications({
    now: '2026-08-14T09:00:00+08:00',
    limit: 0,
  });
  assert.strictEqual(pending[0].notificationId, notificationId);
  assert.strictEqual(pending[0].attempts, 0);

  const marked = await store.markNotificationSent(notificationId, {
    sentAt: '2026-08-14T09:01:00+08:00',
  });
  assert.strictEqual(marked, true);
  assert.deepStrictEqual(calls.map(({ params }) => params), [
    ['2026-08-14T00:00:00.000Z', 500],
    ['2026-08-14T01:00:00.000Z', 100],
    [notificationId, '2026-08-14T01:01:00.000Z'],
  ]);

  await assert.rejects(
    store.enqueueDueRenewalReminders({ now: 'invalid' }),
    /续费提醒入队时间格式不正确/
  );
  await assert.rejects(
    store.listPendingNotifications({ now: 'invalid' }),
    /待发送通知查询时间格式不正确/
  );
  await assert.rejects(
    store.markNotificationSent(''),
    /提醒ID不能为空/
  );
  await assert.rejects(
    store.markNotificationSent(notificationId, { sentAt: 'invalid' }),
    /提醒发送时间格式不正确/
  );

  console.log(JSON.stringify({
    batch: '004j-adapter-local',
    status: 'PASS',
    methodCount: 3,
    networkUsed: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
