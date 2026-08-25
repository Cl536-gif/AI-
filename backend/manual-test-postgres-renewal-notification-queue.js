const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004j_renewal_notification_queue.review.sql'
), 'utf8');

for (const fragment of [
  'CREATE TABLE app.user_notifications',
  'user_notifications_user_dedupe_unique',
  "notification_type IN ('trial_renewal_day_13')",
  "status IN ('pending', 'sent')",
  'created_at >= scheduled_at',
  'ENABLE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE app.user_notifications FROM PUBLIC, diet_app',
  'CREATE OR REPLACE FUNCTION app.enqueue_due_renewal_reminders(',
  'CREATE OR REPLACE FUNCTION app.list_pending_notifications(',
  'CREATE OR REPLACE FUNCTION app.mark_notification_sent(',
  'SECURITY DEFINER',
  "service.status = 'trial_active'",
  'service.trial_ends_at > v_now',
  'ON CONFLICT (user_id, dedupe_key) DO NOTHING',
  "notification.status = 'pending'",
  'attempts = attempts + 1',
  'RETURN FOUND',
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004j迁移SQL缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/^BEGIN;$/gm) || []).length, 1);
assert.strictEqual((sql.match(/^COMMIT;$/gm) || []).length, 1);
assert(!/^ROLLBACK;$/m.test(sql));
assert(!/USER_STORE_ADAPTER\s*=\s*tencent-postgres/.test(sql));

console.log(JSON.stringify({
  batch: '004j',
  check: 'renewal_notification_queue_migration_static_review',
  status: 'PASS',
  directNotificationTableAccessGranted: false,
  productionAdapterSelectionChanged: false,
}));
