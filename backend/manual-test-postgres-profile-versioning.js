const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sqlPath = path.join(
  __dirname,
  'sql',
  'postgres',
  '004c_profile_versioning.review.sql'
);
const sql = fs.readFileSync(sqlPath, 'utf8');

const requiredFragments = [
  'CREATE TABLE app.user_profile_versions',
  'CREATE TABLE app.user_profile_version_history',
  'CREATE OR REPLACE FUNCTION app.profile_changed_fields_is_valid',
  'CHECK (normal_revision_id IS NOT NULL OR menstrual_revision_id IS NOT NULL)',
  'ALTER FUNCTION app.save_current_user_profile(jsonb, varchar)',
  'RENAME TO save_current_user_profile_legacy_004c',
  'CREATE OR REPLACE FUNCTION app.save_current_user_profile_versioned',
  "ERRCODE = '40001'",
  'FOR UPDATE',
  "p_profile - 'menstrualTracking'",
  'app.save_current_user_menstrual_profile(',
  'GRANT SELECT ON app.user_profile_versions TO diet_app',
  'GRANT SELECT ON app.user_profile_version_history TO diet_app',
  'FROM PUBLIC, diet_app',
];

for (const fragment of requiredFragments) {
  assert(sql.includes(fragment), `004c SQL缺少关键片段：${fragment}`);
}

assert(!/UPDATE\s+app\.profile_revisions/i.test(sql));
assert(!/DELETE\s+FROM\s+app\.(profile_revisions|menstrual_profile_revisions)/i.test(sql));
assert(!/GRANT\s+(INSERT|UPDATE|DELETE)[^;]*user_profile_version/i.test(sql));
assert(!/SECURITY\s+DEFINER[\s\S]{0,160}SET\s+search_path\s*=\s*app\b/i.test(sql));

console.log(JSON.stringify({
  batch: '004c',
  check: 'profile_versioning_static_review',
  status: 'PASS',
  unifiedLedgerContainsSensitiveSnapshot: false,
  optimisticConflictCode: '40001',
  cloudSqlExecuted: false,
}));
