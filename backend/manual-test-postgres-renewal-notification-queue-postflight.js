const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004j_renewal_notification_queue_postflight.readonly.sql'
), 'utf8');

for (const fragment of [
  'SET TRANSACTION READ ONLY',
  "THEN 'PASS'",
  'table_owned_and_rls_enabled',
  'notification_columns_valid',
  'primary_key_valid',
  'foreign_key_valid',
  'dedupe_unique_valid',
  'checks_valid',
  'no_direct_rls_policy',
  'diet_app_has_no_direct_table_access',
  'public_has_no_table_access',
  'pending_schedule_index_valid',
  'functions_present',
  'diet_app_can_execute_functions',
  'public_cannot_execute_functions',
  'functions_owned_and_secured',
  'queue_definitions_valid',
  'invalid_notification_row_count',
]) {
  assert(sql.includes(fragment), `004j后置检查缺少关键片段：${fragment}`);
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
  assert(!forbidden.test(executableSql), `004j后置检查包含写操作：${forbidden}`);
}

assert(sql.trim().endsWith('ROLLBACK;'));

console.log(JSON.stringify({
  batch: '004j',
  check: 'cloud_postflight_sql_is_read_only',
  status: 'PASS',
}));
