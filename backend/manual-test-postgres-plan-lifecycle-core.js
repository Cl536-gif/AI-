const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004g_plan_lifecycle_core.review.sql'
), 'utf8');

for (const fragment of [
  'CREATE TABLE app.user_plan_versions',
  'CREATE TABLE app.plan_state_transitions',
  'energy_calculations_user_calculation_unique',
  'user_plan_versions_one_active_per_user_idx',
  'user_plan_versions_parent_fk',
  'CREATE POLICY user_plan_versions_select_own',
  'CREATE POLICY plan_state_transitions_select_own',
  'CREATE OR REPLACE FUNCTION app.create_current_user_plan_draft(',
  'SELECT COALESCE(MAX(plan_version), 0) + 1',
  'CREATE OR REPLACE FUNCTION app.transition_current_user_plan(',
  "v_service_status NOT IN ('trial_active', 'subscribed')",
  "'replaced_by:' || v_plan_id",
  'FOR UPDATE',
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004g SQL缺少关键片段：${fragment}`);
}

assert(!/GRANT\s+(INSERT|UPDATE|DELETE).*(user_plan_versions|plan_state_transitions)/i.test(sql));
assert(!/p_user_id/i.test(sql));
assert(!/SECURITY\s+DEFINER[\s\S]{0,160}SET\s+search_path\s*=\s*app\b/i.test(sql));
assert.strictEqual((sql.match(/\bCOMMIT\s*;/gi) || []).length, 1);

console.log(JSON.stringify({
  batch: '004g',
  check: 'plan_lifecycle_core_static_review',
  status: 'PASS',
  directPlanMutationGrantedToDietApp: false,
  initialTrialActivationDeferredTo004h: true,
  productionAdapterSelectionChanged: false,
}));
