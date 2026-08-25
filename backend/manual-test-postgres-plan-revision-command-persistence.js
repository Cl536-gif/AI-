const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004i_plan_revision_command_persistence.review.sql'
), 'utf8');

for (const fragment of [
  'CREATE TABLE app.plan_revision_commands',
  'PRIMARY KEY',
  'plan_revision_commands_user_plan_fk',
  "status IN ('draft_created', 'delivered')",
  'updated_at >= created_at',
  'ENABLE ROW LEVEL SECURITY',
  'CREATE POLICY plan_revision_commands_select_own',
  'GRANT SELECT ON TABLE app.plan_revision_commands TO diet_app',
  'CREATE OR REPLACE FUNCTION app.record_current_user_plan_revision_command(',
  'SECURITY DEFINER',
  'FOR UPDATE',
  "v_existing.user_id <> v_user_id",
  "v_existing.plan_id <> v_plan_id",
  "v_existing.status = 'delivered' AND v_status = 'draft_created'",
  'ON CONFLICT (command_id) DO UPDATE',
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004i迁移SQL缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/^BEGIN;$/gm) || []).length, 1);
assert.strictEqual((sql.match(/^COMMIT;$/gm) || []).length, 1);
assert(!/^ROLLBACK;$/m.test(sql));
assert(!/USER_STORE_ADAPTER\s*=\s*tencent-postgres/.test(sql));

console.log(JSON.stringify({
  batch: '004i',
  check: 'plan_revision_command_migration_static_review',
  status: 'PASS',
  productionAdapterSelectionChanged: false,
}));
