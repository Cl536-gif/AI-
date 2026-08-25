const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  'sql',
  'postgres',
  '004k_advice_history_verify.review.sql'
), 'utf8');

for (const fragment of [
  'BEGIN;',
  "'acct:004k_verify_a'",
  "'acct:004k_verify_b'",
  'SET LOCAL ROLE diet_app',
  'app.record_current_user_advice(',
  'advice_recorded_idempotently',
  'advice_history_order_and_snapshot_verified',
  'invalid_advice_rejected_without_mutation',
  'cross_user_isolation_and_defaults_verified',
  'ROLLBACK;',
  'remaining_users = 0 AND remaining_advice = 0',
]) {
  assert(sql.includes(fragment), `004k verify缺少关键片段：${fragment}`);
}

assert.strictEqual((sql.match(/\bROLLBACK\s*;/gi) || []).length, 1);
assert.strictEqual((sql.match(/\bCOMMIT\s*;/gi) || []).length, 0);
assert(sql.indexOf('ROLLBACK;') < sql.indexOf('cleanup_status'));
assert(!/DELETE\s+FROM\s+app\./i.test(sql));

console.log(JSON.stringify({
  batch: '004k',
  check: 'advice_history_verify_static_review',
  status: 'PASS',
  rollbackOnly: true,
  cleanupProven: true,
}));
