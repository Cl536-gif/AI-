const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004g_plan_lifecycle_core_verify.review.sql'
), 'utf8');

for (const fragment of [
  "SELECT set_config('app.current_user_id', 'acct:004g_verify_a', true)",
  'SET LOCAL ROLE diet_app',
  'app.record_current_user_energy_calculation',
  'app.create_current_user_plan_draft',
  'app.transition_current_user_plan',
  'plan_version_state_machine_and_invalid_paths_verified',
  'cross_user_rls_isolation',
  'rollback_cleanup_status',
]) {
  assert(sql.includes(fragment), `004g云端沙箱缺少关键片段：${fragment}`);
}

assert.strictEqual(
  (sql.match(/^BEGIN;$/gm) || []).length,
  1,
  '004g云端沙箱必须只有一个外层事务'
);
assert.strictEqual(
  (sql.match(/^ROLLBACK;$/gm) || []).length,
  1,
  '004g云端沙箱必须以一次ROLLBACK清理'
);
assert(!/^COMMIT;$/m.test(sql), '004g云端沙箱不得COMMIT');
assert(sql.indexOf('ROLLBACK;') < sql.indexOf('rollback_cleanup_status'));

console.log(JSON.stringify({
  batch: '004g',
  check: 'cloud_rollback_sandbox_static_review',
  status: 'PASS',
}));
