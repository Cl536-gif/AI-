const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004e_service_status_preflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "THEN 'PASS'",
  'service_status_table_absent',
  'service_transitions_table_absent',
  'service_status_function_absent',
  'diet_app_cannot_update_users_directly',
]) {
  assert(sql.includes(fragment), `004e预检缺少关键片段：${fragment}`);
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
  assert(!forbidden.test(executableSql), `004e预检包含写操作：${forbidden}`);
}

assert(sql.trim().endsWith('ROLLBACK;'));

console.log(JSON.stringify({
  batch: '004e',
  check: 'cloud_preflight_sql_is_read_only',
  status: 'PASS',
}));
