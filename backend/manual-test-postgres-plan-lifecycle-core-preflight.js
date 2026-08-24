const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004g_plan_lifecycle_core_preflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "THEN 'PASS'",
  'prerequisite_tables_valid',
  'plan_versions_table_absent',
  'plan_transitions_table_absent',
  'create_plan_function_absent',
  'transition_plan_function_absent',
  'energy_composite_unique_absent',
]) {
  assert(sql.includes(fragment), `004g预检缺少关键片段：${fragment}`);
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
  /\bGRANT/i,
  /\bREVOKE/i,
]) {
  assert(!forbidden.test(executableSql), `004g预检包含写操作：${forbidden}`);
}

assert(sql.trim().endsWith('ROLLBACK;'));

console.log(JSON.stringify({
  batch: '004g',
  check: 'cloud_preflight_sql_is_read_only',
  status: 'PASS',
}));
