const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004c_profile_versioning_postflight.readonly.sql'
), 'utf8');

assert(sql.includes('SET TRANSACTION READ ONLY'));
assert(sql.includes("THEN 'PASS'"));
assert(sql.includes('diet_app_cannot_execute_legacy'));
assert(sql.includes('public_cannot_execute_versioned'));
assert(sql.includes('version_row_count = 0'));
assert(sql.includes('history_row_count = 0'));
assert(sql.trim().endsWith('ROLLBACK;'));

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
  assert(!forbidden.test(executableSql), `部署后核验包含写操作：${forbidden}`);
}

console.log(JSON.stringify({
  batch: '004c',
  check: 'cloud_postflight_sql_is_read_only',
  status: 'PASS',
}));

