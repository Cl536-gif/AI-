const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004e_service_status_verify.review.sql'
), 'utf8');

for (const fragment of [
  "SELECT set_config('app.current_user_id', 'acct:004e_verify_a', true)",
  'NULL>onboarding_incomplete',
  'onboarding_incomplete>profile_confirmed',
  'profile_confirmed>trial_active',
  "WHEN SQLSTATE '22023' THEN NULL",
  "SELECT set_config('app.current_user_id', 'acct:004e_verify_b', true)",
  "SELECT 'PASS' AS cross_user_rls_isolation",
  'ROLLBACK;',
  'rollback_cleanup_status',
]) {
  assert(sql.includes(fragment), `004e云端验证缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/\bCOMMIT\s*;/gi) || []).length, 0);
assert.strictEqual((sql.match(/\bROLLBACK\s*;/gi) || []).length, 1);
assert(!/\b(password|host|connection string)\b/i.test(sql));

console.log(JSON.stringify({
  batch: '004e',
  check: 'cloud_sandbox_verification_guard',
  status: 'PASS',
  expectedFinalCleanup: 'PASS',
}));
