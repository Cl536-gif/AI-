const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004g_plan_lifecycle_core_postflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "THEN 'PASS'",
  'tables_owned_and_rls_enabled',
  'plan_columns_valid',
  'transition_columns_valid',
  'plan_constraints_valid',
  'transition_constraints_valid',
  'energy_composite_unique_valid',
  'select_policies_valid',
  'plan_indexes_valid',
  'transition_index_valid',
  'functions_owned_and_secured',
  'diet_app_cannot_mutate_plan_tables',
]) {
  assert(sql.includes(fragment), `004g后置检查缺少关键片段：${fragment}`);
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
  assert(!forbidden.test(executableSql), `004g后置检查包含写操作：${forbidden}`);
}

assert(sql.trim().endsWith('ROLLBACK;'));

console.log(JSON.stringify({
  batch: '004g',
  check: 'cloud_postflight_sql_is_read_only',
  status: 'PASS',
}));
