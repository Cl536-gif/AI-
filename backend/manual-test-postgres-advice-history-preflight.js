const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004k_advice_history_preflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "current_database() = 'diet_secretary'",
  "class.relname = 'users'",
  "procedure.proname IN ('current_user_id', 'current_user_is_active')",
  "to_regclass('app.user_advice_history') IS NULL",
  "'app.record_current_user_advice(jsonb,timestamp with time zone)'",
  'COUNT(*) AS existing_user_count',
  "THEN 'PASS'",
  'ROLLBACK;',
]) {
  assert(sql.includes(fragment), `004k preflight缺少关键片段：${fragment}`);
}

assert(!/^\s*(COMMIT|CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/im.test(sql));
assert(!/user_id\s*,|content|metadata\s*(,|FROM)/i.test(sql));

console.log(JSON.stringify({
  batch: '004k',
  check: 'advice_history_preflight_static_review',
  status: 'PASS',
  readOnly: true,
  sensitiveRowsSelected: false,
}));
