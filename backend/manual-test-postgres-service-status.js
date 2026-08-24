const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004e_service_status.review.sql'
), 'utf8');

for (const fragment of [
  'CREATE TABLE app.user_service_status',
  'CREATE TABLE app.user_service_transitions',
  'user_service_status_value_chk',
  'user_service_active_trial_complete_chk',
  'CREATE POLICY user_service_status_select_own',
  'CREATE POLICY user_service_transitions_select_own',
  'CREATE OR REPLACE FUNCTION app.set_current_user_service_status(',
  "key_name NOT IN (",
  'FOR UPDATE',
  'ON CONFLICT (user_id) DO UPDATE SET',
  'v_previous_status',
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004e SQL缺少关键片段：${fragment}`);
}

assert(!/GRANT\s+(INSERT|UPDATE|DELETE).*user_service_/i.test(sql));
assert(!/p_user_id/i.test(sql));
assert(!/SECURITY\s+DEFINER[\s\S]{0,160}SET\s+search_path\s*=\s*app\b/i.test(sql));
assert.strictEqual((sql.match(/\bCOMMIT\s*;/gi) || []).length, 1);

console.log(JSON.stringify({
  batch: '004e',
  check: 'service_status_static_review',
  status: 'PASS',
  directServiceMutationGrantedToDietApp: false,
  productionAdapterSelectionChanged: false,
}));
