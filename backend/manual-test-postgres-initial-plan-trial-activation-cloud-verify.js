const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004h_initial_plan_trial_activation_verify.review.sql'
), 'utf8');

for (const fragment of [
  "SELECT set_config('app.current_user_id', 'acct:004h_verify_a', true)",
  "SELECT set_config('app.current_user_id', 'acct:004h_verify_b', true)",
  'SET LOCAL ROLE diet_app',
  'app.activate_current_user_initial_plan_and_trial',
  "set_config('app.verify_004h_plan_a'",
  "current_setting('app.verify_004h_plan_a')",
  'atomic_activation_and_histories_verified',
  'idempotent_retry_verified',
  'invalid_activation_rolled_back',
  'cross_user_rls_isolation',
  'rollback_cleanup_status',
]) {
  assert(sql.includes(fragment), `004h云端沙箱缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/^BEGIN;$/gm) || []).length, 1);
assert.strictEqual((sql.match(/^ROLLBACK;$/gm) || []).length, 1);
assert(!/^COMMIT;$/m.test(sql));
assert(!sql.includes('app.004h_verify_plan_a'));
assert(sql.indexOf('ROLLBACK;') < sql.indexOf('rollback_cleanup_status'));

console.log(JSON.stringify({
  batch: '004h',
  check: 'cloud_rollback_sandbox_static_review',
  status: 'PASS',
}));
