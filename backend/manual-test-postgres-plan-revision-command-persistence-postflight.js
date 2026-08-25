const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004i_plan_revision_command_persistence_postflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "THEN 'PASS'",
  'table_owned_and_rls_enabled',
  'command_columns_valid',
  'primary_key_valid',
  'foreign_keys_valid',
  'checks_valid',
  'select_policy_valid',
  'diet_app_cannot_mutate',
  'public_has_no_table_access',
  'user_updated_index_valid',
  'record_function_present',
  'function_owned_and_secured',
  'invalid_command_row_count',
]) {
  assert(sql.includes(fragment), `004i后置检查缺少关键片段：${fragment}`);
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
  assert(!forbidden.test(executableSql), `004i后置检查包含写操作：${forbidden}`);
}

assert(sql.trim().endsWith('ROLLBACK;'));

console.log(JSON.stringify({
  batch: '004i',
  check: 'cloud_postflight_sql_is_read_only',
  status: 'PASS',
}));
