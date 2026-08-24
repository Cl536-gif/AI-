const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004d_user_activity_settings_preflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "THEN 'PASS'",
  'target_columns_absent',
  'target_functions_absent',
  'diet_app_cannot_update_users_directly',
  'users_with_unknown_status = 0',
  'users_with_missing_baseline_time = 0',
  'ROLLBACK;',
]) {
  assert(sql.includes(fragment), `004d前置检查缺少关键片段：${fragment}`);
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
  assert(!forbidden.test(executableSql), `004d前置检查包含写操作：${forbidden}`);
}

console.log(JSON.stringify({
  batch: '004d',
  check: 'cloud_preflight_sql_is_read_only',
  status: 'PASS',
}));

