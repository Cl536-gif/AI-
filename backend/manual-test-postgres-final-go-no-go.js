const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { USER_STORE_METHODS } = require('./src/stores/userStoreContract');
const {
  ACCEPTANCE_INTEGRITY_CONFIRMATION,
  FINAL_REVIEW_CONFIRMATION,
  METHOD_EVIDENCE_CONFIRMATION,
  MODEL_MONITORING_CONFIRMATION,
  PREPRODUCTION_CONFIRMATION,
  ROLLBACK_CONTROL_CONFIRMATION,
  SIDE_EFFECT_RECOVERY_CONFIRMATION,
  assertFinalPostgresGoNoGoAllowed,
} = require('./src/db/postgresFinalGoNoGoGate');
const {
  FULL_CUTOVER_CONFIRMATION,
  FULL_CUTOVER_MODE,
  assertTencentPostgresCutoverAllowed,
} = require('./src/stores/tencentPostgresCutoverGate');

const matrixPath = path.join(__dirname, 'sql/postgres/005m_method_evidence_matrix.review.csv');
const rows = fs.readFileSync(matrixPath, 'utf8').trim().split('\n').slice(1).map((line) => {
  const [methodName, evidencePackage, status] = line.split(',');
  return { methodName, evidencePackage, status };
});
assert.strictEqual(rows.length, USER_STORE_METHODS.length);
assert.deepStrictEqual(
  [...new Set(rows.map(({ methodName }) => methodName))].sort(),
  [...USER_STORE_METHODS].sort()
);
assert(rows.every(({ status }) => status === 'cloud_verified'));

const packages = [...new Set(rows.map(({ evidencePackage }) => evidencePackage))];
const finalEvidencePackages = [
  ...packages,
  '005o-bailian-model-monitor',
  '005p-preproduction-observation',
];
for (const evidencePackage of finalEvidencePackages) {
  const root = path.join(__dirname, '../docs/acceptance', evidencePackage);
  const manifestPath = path.join(root, 'MANIFEST.sha256');
  assert(fs.existsSync(manifestPath), `缺少验收清单：${evidencePackage}`);
  const entries = fs.readFileSync(manifestPath, 'utf8').trim().split('\n');
  assert(entries.length > 0, `空验收清单：${evidencePackage}`);
  for (const entry of entries) {
    const match = entry.match(/^([a-f0-9]{64})  ([^/]+)$/);
    assert(match, `不安全的验收清单条目：${evidencePackage}`);
    const target = path.join(root, match[2]);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    assert.strictEqual(digest, match[1], `验收摘要不匹配：${evidencePackage}`);
  }
}

const completeEnv = {
  RUN_005M_FINAL_REVIEW: FINAL_REVIEW_CONFIRMATION,
  RUN_005M_METHOD_EVIDENCE: METHOD_EVIDENCE_CONFIRMATION,
  RUN_005M_ACCEPTANCE_INTEGRITY: ACCEPTANCE_INTEGRITY_CONFIRMATION,
  RUN_005M_SIDE_EFFECT_RECOVERY: SIDE_EFFECT_RECOVERY_CONFIRMATION,
  RUN_005M_ROLLBACK_CONTROL: ROLLBACK_CONTROL_CONFIRMATION,
  RUN_005M_MODEL_MONITORING: MODEL_MONITORING_CONFIRMATION,
  RUN_005M_PREPRODUCTION_OBSERVATION: PREPRODUCTION_CONFIRMATION,
  TENCENT_PG_005M_OBSERVATION_MINUTES: '60',
  TENCENT_PG_005M_REQUEST_COUNT: '100',
  TENCENT_PG_005M_READINESS_FAILURES: '0',
  TENCENT_PG_005M_CONNECTION_TIMEOUTS: '0',
  TENCENT_PG_005M_TRANSACTION_FAILURES: '0',
  TENCENT_PG_005M_IDENTITY_FAILURES: '0',
  TENCENT_PG_005M_SIDE_EFFECT_FAILURES: '0',
  TENCENT_PG_005M_HTTP_5XX: '0',
  TENCENT_PG_005M_POOL_WAITING_MAX: '0',
};

const go = assertFinalPostgresGoNoGoAllowed({ env: completeEnv });
assert.strictEqual(go.decision, 'GO');
assert.strictEqual(go.observationMinutes, 60);
assert.strictEqual(go.requestCount, 100);

assert.throws(
  () => assertFinalPostgresGoNoGoAllowed({ env: {} }),
  (error) => error?.code === 'POSTGRES_FINAL_REVIEW_REQUIRED'
);
assert.throws(
  () => assertFinalPostgresGoNoGoAllowed({
    env: { ...completeEnv, RUN_005M_SIDE_EFFECT_RECOVERY: '' },
  }),
  (error) => error?.code === 'POSTGRES_FINAL_SIDE_EFFECT_RECOVERY_REQUIRED'
);
assert.throws(
  () => assertFinalPostgresGoNoGoAllowed({
    env: { ...completeEnv, TENCENT_PG_005M_HTTP_5XX: '1' },
  }),
  (error) => error?.code === 'POSTGRES_FINAL_OBSERVATION_FAILED'
);
assert.throws(
  () => assertTencentPostgresCutoverAllowed({
    env: {
      TENCENT_PG_CUTOVER_MODE: FULL_CUTOVER_MODE,
      TENCENT_PG_CUTOVER_CONFIRM: FULL_CUTOVER_CONFIRMATION,
    },
    isFullCutoverReady: () => true,
  }),
  (error) => error?.code === 'POSTGRES_FINAL_REVIEW_REQUIRED'
);

console.log(JSON.stringify({
  batch: '005m-final-go-no-go',
  status: 'PASS',
  decision: 'GO',
  methodEvidenceCount: rows.length,
  evidencePackageCount: finalEvidencePackages.length,
  acceptanceIntegrityVerified: true,
  fullCutoverFailsClosedWithoutFinalEvidence: true,
  blockerCount: 0,
  blockers: [],
}));
