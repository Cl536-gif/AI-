const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004i_plan_revision_command_persistence_verify.review.sql'
), 'utf8');

for (const fragment of [
  '004i_verify_a',
  '004i_verify_b',
  'app.verify_004i_plan_a',
  'draft_command_recorded',
  'draft_retry_idempotent',
  'command_advanced_to_delivered',
  'plan_rebinding_rejected',
  'cross_user_collision_rejected_and_isolated',
  "WHEN SQLSTATE '22023'",
  'WHEN unique_violation',
  'ROLLBACK;',
  'cleanup_status',
]) {
  assert(sql.includes(fragment), `004i功能沙箱缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/^BEGIN;$/gm) || []).length, 1);
assert.strictEqual((sql.match(/^ROLLBACK;$/gm) || []).length, 1);
assert(!/^COMMIT;$/m.test(sql));
assert(!sql.includes('app.004i_'));

console.log(JSON.stringify({
  batch: '004i',
  check: 'cloud_rollback_sandbox_static_review',
  status: 'PASS',
  cleanup: 'ROLLBACK',
}));
