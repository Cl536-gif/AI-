const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004j_renewal_notification_queue_verify.review.sql'
), 'utf8');

for (const fragment of [
  '004j_verify_a',
  '004j_verify_b',
  'app.verify_004j_notification',
  'reminder_not_enqueued_early',
  'due_reminder_enqueued_idempotently',
  'pending_queue_and_rpc_only_access_verified',
  'expired_trial_skipped',
  'notification_marked_sent_once',
  'WHEN insufficient_privilege',
  'ROLLBACK;',
  'cleanup_status',
]) {
  assert(sql.includes(fragment), `004j功能沙箱缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/^BEGIN;$/gm) || []).length, 1);
assert.strictEqual((sql.match(/^ROLLBACK;$/gm) || []).length, 1);
assert(!/^COMMIT;$/m.test(sql));
assert(!sql.includes('app.004j_'));

console.log(JSON.stringify({
  batch: '004j',
  check: 'cloud_rollback_sandbox_static_review',
  status: 'PASS',
  cleanup: 'ROLLBACK',
}));
