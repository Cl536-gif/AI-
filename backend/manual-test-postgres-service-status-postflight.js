const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004e_service_status_postflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "THEN 'PASS'",
  'tables_owned_and_rls_enabled',
  'constraints_valid',
  'select_policies_valid',
  'transition_index_valid',
  'function_owned_and_secured',
  'diet_app_cannot_mutate_service_tables',
]) {
  assert(sql.includes(fragment), `004e后置检查缺少关键片段：${fragment}`);
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
  assert(!forbidden.test(executableSql), `004e后置检查包含写操作：${forbidden}`);
}

assert(sql.trim().endsWith('ROLLBACK;'));

console.log(JSON.stringify({
  batch: '004e',
  check: 'cloud_postflight_sql_is_read_only',
  status: 'PASS',
}));
