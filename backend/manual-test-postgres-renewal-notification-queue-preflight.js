const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004j_renewal_notification_queue_preflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "THEN 'PASS'",
  'prerequisite_tables_valid',
  'service_columns_valid',
  'notifications_table_absent',
  'enqueue_function_absent',
  'list_function_absent',
  'mark_sent_function_absent',
  'incomplete_active_trial_count',
]) {
  assert(sql.includes(fragment), `004j预检缺少关键片段：${fragment}`);
}

const executableSql = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

for (const forbidden of [
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+app\./i,
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+(TABLE|FUNCTION|POLICY|INDEX)\b/i,
  /\bALTER\s+(TABLE|FUNCTION)\b/i,
  /\bDROP\s+(TABLE|FUNCTION|POLICY|INDEX)\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
]) {
  assert(!forbidden.test(executableSql), `004j预检包含写操作：${forbidden}`);
}

assert(sql.trim().endsWith('ROLLBACK;'));

console.log(JSON.stringify({
  batch: '004j',
  check: 'cloud_preflight_sql_is_read_only',
  status: 'PASS',
}));
