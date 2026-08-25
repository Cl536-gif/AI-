const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004k_advice_history_postflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "class.relname = 'user_advice_history'",
  'COUNT(*) = 9 AS advice_columns_valid',
  "constraint_record.contype = 'u'",
  "policy.polname = 'user_advice_history_select_own'",
  "has_table_privilege('diet_app', 'app.user_advice_history', 'SELECT')",
  "'app.record_current_user_advice(jsonb,timestamp with time zone)'",
  "procedure.prosrc LIKE '%ON CONFLICT (user_id, idempotency_key)%'",
  'invalid_advice_row_count = 0',
  "THEN 'PASS'",
  'ROLLBACK;',
]) {
  assert(sql.includes(fragment), `004k postflight缺少关键片段：${fragment}`);
}

assert(!/^\s*(COMMIT|CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/im.test(sql));
assert(!/SELECT\s+(advice_id|user_id|content|metadata|idempotency_key)\b/i.test(sql));

console.log(JSON.stringify({
  batch: '004k',
  check: 'advice_history_postflight_static_review',
  status: 'PASS',
  readOnly: true,
  sensitiveRowsSelected: false,
}));
