const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004k_advice_history.review.sql'
), 'utf8');

for (const fragment of [
  'CREATE TABLE app.user_advice_history',
  'user_advice_history_user_idempotency_unique',
  'user_advice_history_metadata_chk',
  'CREATE POLICY user_advice_history_select_own',
  'CREATE OR REPLACE FUNCTION app.record_current_user_advice(',
  "octet_length(p_advice::text) > 196608",
  'FROM jsonb_object_keys(p_advice) AS next_key(key_name)',
  'ON CONFLICT (user_id, idempotency_key) DO UPDATE',
  'FOR UPDATE',
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004k SQL缺少关键片段：${fragment}`);
}

assert(!/GRANT\s+(INSERT|UPDATE|DELETE).*user_advice_history/i.test(sql));
assert(!/p_user_id/i.test(sql));
assert(!/SECURITY\s+DEFINER[\s\S]{0,160}SET\s+search_path\s*=\s*app\b/i.test(sql));
assert.strictEqual((sql.match(/\bCOMMIT\s*;/gi) || []).length, 1);

console.log(JSON.stringify({
  batch: '004k',
  check: 'advice_history_static_review',
  status: 'PASS',
  directAdviceMutationGrantedToDietApp: false,
  productionAdapterSelectionChanged: false,
}));
