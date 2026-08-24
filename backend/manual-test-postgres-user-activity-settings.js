const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004d_user_activity_settings.review.sql'
), 'utf8');

for (const fragment of [
  'ADD COLUMN last_active_at timestamptz',
  "ADD COLUMN timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai'",
  "ADD COLUMN locale varchar(16) NOT NULL DEFAULT 'zh-CN'",
  'CREATE INDEX users_last_active_idx',
  'CREATE OR REPLACE FUNCTION app.record_current_user_activity()',
  'RETURNING true INTO v_inserted',
  'CREATE OR REPLACE FUNCTION app.update_current_user_timezone(p_timezone varchar)',
  'FROM pg_catalog.pg_timezone_names AS timezone_name',
  "ERRCODE = '22023'",
  'FOR UPDATE',
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004d SQL缺少关键片段：${fragment}`);
}

assert(!/GRANT\s+UPDATE\s+ON\s+app\.users\s+TO\s+diet_app/i.test(sql));
assert(!/SECURITY\s+DEFINER[\s\S]{0,160}SET\s+search_path\s*=\s*app\b/i.test(sql));
assert(!/p_user_id/i.test(sql));
assert.strictEqual((sql.match(/\bCOMMIT\s*;/gi) || []).length, 1);

console.log(JSON.stringify({
  batch: '004d',
  check: 'user_activity_settings_static_review',
  status: 'PASS',
  directUserUpdateGrantedToDietApp: false,
  cloudSqlExecutedByStaticTest: false,
}));
