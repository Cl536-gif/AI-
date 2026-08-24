const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004f_energy_calculations.review.sql'
), 'utf8');

for (const fragment of [
  'CREATE TABLE app.energy_calculations',
  'energy_calculations_inputs_object_chk',
  'energy_calculations_assumptions_array_chk',
  'energy_calculations_outputs_object_chk',
  'energy_calculations_source_refs_array_chk',
  'CREATE POLICY energy_calculations_select_own',
  'CREATE OR REPLACE FUNCTION app.record_current_user_energy_calculation(',
  'octet_length(p_calculation::text) > 131072',
  'FROM jsonb_object_keys(p_calculation) AS next_key(key_name)',
  'FOR UPDATE',
  'FROM PUBLIC',
  'TO diet_app, diet_owner',
]) {
  assert(sql.includes(fragment), `004f SQL缺少关键片段：${fragment}`);
}

assert(!/GRANT\s+(INSERT|UPDATE|DELETE).*energy_calculations/i.test(sql));
assert(!/p_user_id/i.test(sql));
assert(!/SECURITY\s+DEFINER[\s\S]{0,160}SET\s+search_path\s*=\s*app\b/i.test(sql));
assert.strictEqual((sql.match(/\bCOMMIT\s*;/gi) || []).length, 1);

console.log(JSON.stringify({
  batch: '004f',
  check: 'energy_calculations_static_review',
  status: 'PASS',
  directEnergyMutationGrantedToDietApp: false,
  productionAdapterSelectionChanged: false,
}));
