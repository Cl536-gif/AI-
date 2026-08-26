const assert = require('assert');
const fs = require('fs');
const path = require('path');

function assertDistinctRevisionFingerprints(baseline, rollback) {
  assert(/^[a-f0-9]{64}$/.test(String(baseline || '')));
  assert(/^[a-f0-9]{64}$/.test(String(rollback || '')));
  assert.notStrictEqual(baseline, rollback);
  return true;
}

assert.strictEqual(
  assertDistinctRevisionFingerprints('a'.repeat(64), 'b'.repeat(64)),
  true
);
assert.throws(() => assertDistinctRevisionFingerprints('a'.repeat(64), 'a'.repeat(64)));
assert.throws(() => assertDistinctRevisionFingerprints('bad', 'b'.repeat(64)));

const sql = fs.readFileSync(
  path.join(__dirname, 'sql/postgres/005k_post_rollback_residue.review.sql'),
  'utf8'
);
const withoutComments = sql.replace(/^--.*$/gm, '');
assert(sql.includes('SET TRANSACTION READ ONLY'));
assert(sql.includes('postgres_identity_preserved'));
assert(sql.includes('postgres_user_preserved'));
assert(sql.includes('postgres_advice_rows_preserved'));
assert(sql.trim().endsWith('ROLLBACK;'));
assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(withoutComments));
const emittedResult = sql.slice(sql.lastIndexOf('\nSELECT\n'));
assert(!/(external_subject_hash|user_id|content|payload_json)/i.test(emittedResult));

console.log(JSON.stringify({
  batch: '005k-sqlite-rollback-rehearsal',
  status: 'PASS',
  distinctCloudRevisionsRequired: true,
  postgresResidueCheckReadOnly: true,
  postgresWritesMustRemainAfterApplicationRollback: true,
  sensitiveRowsEmitted: false,
}));

module.exports = { assertDistinctRevisionFingerprints };
