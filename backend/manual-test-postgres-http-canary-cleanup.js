const assert = require('assert');
const fs = require('fs');
const path = require('path');

const postgresDir = path.join(__dirname, 'sql', 'postgres');
const preflight = fs.readFileSync(
  path.join(postgresDir, '005c_http_canary_preflight.review.sql'),
  'utf8'
);
const cleanup = fs.readFileSync(
  path.join(postgresDir, '005c_http_canary_cleanup.review.sql'),
  'utf8'
);
const fixedDeviceId = '005c0000-0000-4000-8000-000000000001';

assert(preflight.includes(fixedDeviceId));
assert(cleanup.includes(fixedDeviceId));
assert(preflight.includes("'diet-secretary-device:v1:' || v_device_id"));
assert(cleanup.includes("'diet-secretary-device:v1:' || v_device_id"));
assert(preflight.includes('v_identity_count <> 0'));
assert(preflight.includes("to_regclass('app.' || v_table)"));
assert(cleanup.includes('v_identity_count <> 1'));
assert(cleanup.includes("v_user_id NOT LIKE 'anon:%'"));
assert(!cleanup.includes('v_advice_count < 1'));
assert(cleanup.includes('http_advice_was_persisted'));
assert(cleanup.includes('source_user_id = v_user_id OR target_user_id = v_user_id'));
assert(cleanup.includes('merged_into_user_id = v_user_id'));

const requiredUserTables = [
  'long_term_profile_field_confirmations',
  'long_term_profile_confirmation_requests',
  'plan_revision_commands',
  'plan_state_transitions',
  'user_plan_versions',
  'user_notifications',
  'user_advice_history',
  'energy_calculations',
  'user_service_transitions',
  'user_service_status',
  'user_profile_version_history',
  'user_profile_versions',
  'profile_revisions',
  'menstrual_profile_revisions',
  'user_events',
  'user_consents',
  'user_profiles',
  'user_menstrual_profiles',
  'user_identities',
  'users',
];

for (const table of requiredUserTables) {
  assert(
    cleanup.includes(`DELETE FROM app.${table}`),
    `005c清理脚本缺少表：${table}`
  );
}

assert(!/DELETE\s+FROM\s+app\.[A-Za-z0-9_]+\s*;/i.test(cleanup));
assert(!/TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE/i.test(cleanup));
assert(!/external_subject_hash\s+LIKE|user_id\s+LIKE\s+'anon:%'/i.test(cleanup));
assert(cleanup.includes("set_config('app.verify_005c_cleanup', 'PASS', true)"));
assert(cleanup.includes('COMMIT;'));

console.log(JSON.stringify({
  batch: '005c-postgres-http-canary-cleanup',
  status: 'PASS',
  fixedTestIdentityOnly: true,
  mergeParticipationRejected: true,
  requiredTableCount: requiredUserTables.length,
  broadDeleteRejected: true,
  cleanupRunsEvenWhenAdviceEvidenceFails: true,
  cleanupProofRequired: true,
}));
