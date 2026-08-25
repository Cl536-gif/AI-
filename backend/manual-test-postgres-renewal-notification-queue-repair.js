const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004j_renewal_notification_queue_enqueue_repair.review.sql'
), 'utf8');

for (const fragment of [
  'CREATE OR REPLACE FUNCTION app.enqueue_due_renewal_reminders(',
  'SECURITY DEFINER',
  'ON CONFLICT (user_id, dedupe_key) DO NOTHING',
  'RETURNING *',
  'resolved_notifications AS',
  'SELECT inserted.*',
  'FROM resolved_notifications AS notification',
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004j入队修复SQL缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/^BEGIN;$/gm) || []).length, 1);
assert.strictEqual((sql.match(/^COMMIT;$/gm) || []).length, 1);
assert(!/^ROLLBACK;$/m.test(sql));
assert(!/CREATE TABLE app\.user_notifications/.test(sql));
assert(!/USER_STORE_ADAPTER\s*=\s*tencent-postgres/.test(sql));

console.log(JSON.stringify({
  batch: '004j-repair',
  check: 'enqueue_returning_visibility_repair_static_review',
  status: 'PASS',
  tableRecreated: false,
  productionAdapterSelectionChanged: false,
}));
