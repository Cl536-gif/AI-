const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004c_profile_versioning_preflight.readonly.sql'
), 'utf8');

assert(sql.includes('SET TRANSACTION READ ONLY'));
assert(sql.includes("THEN 'PASS'"));
assert(sql.includes('normal_profiles_without_history = 0'));
assert(sql.includes('menstrual_profiles_without_history = 0'));
assert(sql.includes('migration_targets_absent'));
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
  assert(!forbidden.test(executableSql), `只读前置检查包含写操作：${forbidden}`);
}

console.log(JSON.stringify({
  batch: '004c',
  check: 'cloud_preflight_sql_is_read_only',
  status: 'PASS',
}));

