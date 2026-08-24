const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004h_initial_plan_trial_activation.review.sql'
), 'utf8');

for (const fragment of [
  'CREATE OR REPLACE FUNCTION app.activate_current_user_initial_plan_and_trial(',
  'SECURITY DEFINER',
  'FOR UPDATE',
  "v_plan.status = 'active'",
  "v_service.status = 'trial_active'",
  "v_service.official_plan_id = v_plan_id",
  "v_plan.status IS DISTINCT FROM 'draft'",
  "v_service.status IS DISTINCT FROM 'profile_confirmed'",
  "interval '336 hours'",
  "interval '312 hours'",
  "SET status = 'active'",
  "'official_plan_delivered'",
  "SET status = 'trial_active'",
  "'first_official_plan_delivered'",
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004h原子激活SQL缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/^BEGIN;$/gm) || []).length, 1);
assert.strictEqual((sql.match(/^COMMIT;$/gm) || []).length, 1);
assert(!/^ROLLBACK;$/m.test(sql));
assert(!/USER_STORE_ADAPTER\s*=\s*tencent-postgres/.test(sql));

console.log(JSON.stringify({
  batch: '004h',
  check: 'initial_plan_trial_atomic_rpc_static_review',
  status: 'PASS',
  productionAdapterSelectionChanged: false,
}));
