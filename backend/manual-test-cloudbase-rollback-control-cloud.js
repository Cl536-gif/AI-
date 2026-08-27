const fs = require('fs');
const path = require('path');
const {
  createPostgresOperationalSnapshot,
  evaluatePostgresRollbackSignals,
  parsePostgresRollbackPolicy,
} = require('./src/db/postgresRollbackSignals');
const {
  assertRollbackEnvironment,
  loadRollbackArtifact,
  sha256,
  verifyRollbackArtifactFiles,
} = require('./src/release/sqliteRollbackArtifact');
const {
  resolveCloudRevisionIdentity,
} = require('./manual-test-sqlite-rollback-cloud');

const VERIFY_CONFIRMATION = 'CONFIRMED_005N_CLOUDBASE_ROLLBACK_CONTROL';
const DEDICATED_CONFIRMATION = 'CONFIRMED_005N_DEDICATED_ROLLBACK_SERVICE';
const CONTROL_PLANE_CONFIRMATION = 'CONFIRMED_005N_MANUAL_CLOUDBASE_ROLLBACK';
const ALLOWED_PHASES = new Set(['baseline', 'signal', 'verify']);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^005n-cloud-[0-9]{8}-[0-9]{2}$/;

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function readRequired(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) fail(`${name}_REQUIRED`);
  return value;
}

function assertFingerprint(value, code) {
  if (!FINGERPRINT_PATTERN.test(value)) fail(code);
  return value;
}

function assert005nCloudEnvironment(env = process.env, phase) {
  if (String(env.RUN_005N_ROLLBACK_CONTROL_VERIFY || '').trim() !== VERIFY_CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.RUN_005N_DEDICATED_SERVICE || '').trim() !== DEDICATED_CONFIRMATION) {
    fail('DEDICATED_SERVICE_REQUIRED');
  }
  if (!ALLOWED_PHASES.has(phase)) fail('ROLLBACK_CONTROL_PHASE_UNSUPPORTED');

  const runId = readRequired(env, 'CLOUDBASE_ROLLBACK_RUN_ID');
  if (!RUN_ID_PATTERN.test(runId)) fail('ROLLBACK_RUN_ID_INVALID');

  const role = readRequired(env, 'CLOUDBASE_ROLLBACK_REHEARSAL_ROLE').toLowerCase();
  const expectedRole = phase === 'signal' ? 'canary' : 'stable';
  if (role !== expectedRole) fail('ROLLBACK_REVISION_ROLE_MISMATCH');

  const artifact = loadRollbackArtifact();
  const environment = assertRollbackEnvironment({ artifact, env });
  const revision = resolveCloudRevisionIdentity(env);
  const currentFingerprint = sha256(revision.value);

  let stableFingerprint = null;
  let canaryFingerprint = null;
  if (phase !== 'baseline') {
    stableFingerprint = assertFingerprint(
      readRequired(env, 'CLOUDBASE_005N_STABLE_REVISION_FINGERPRINT'),
      'STABLE_REVISION_FINGERPRINT_INVALID'
    );
  }
  if (phase === 'signal' && currentFingerprint === stableFingerprint) {
    fail('CANARY_REVISION_NOT_DISTINCT');
  }
  if (phase === 'verify') {
    canaryFingerprint = assertFingerprint(
      readRequired(env, 'CLOUDBASE_005N_CANARY_REVISION_FINGERPRINT'),
      'CANARY_REVISION_FINGERPRINT_INVALID'
    );
    if (String(env.RUN_005N_CONTROL_PLANE_ACTION || '').trim() !== CONTROL_PLANE_CONFIRMATION) {
      fail('CONTROL_PLANE_ACTION_CONFIRMATION_REQUIRED');
    }
    if (currentFingerprint !== stableFingerprint) fail('STABLE_REVISION_NOT_RESTORED');
    if (canaryFingerprint === stableFingerprint) fail('REVISION_TRANSITION_NOT_DISTINCT');
  }

  return Object.freeze({
    artifact,
    environment,
    phase,
    role,
    runId,
    currentFingerprint,
    stableFingerprint,
    canaryFingerprint,
    revisionIdentitySource: revision.source,
  });
}

async function fetchLocal(pathname, port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      signal: controller.signal,
    });
    return { status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyHealth(artifact, port) {
  for (const check of artifact.health) {
    const result = await fetchLocal(check.path, port);
    if (result.status !== check.expectedStatus) fail('ROLLBACK_CONTROL_HEALTH_CHECK_FAILED');
  }
}

async function run(phase = process.argv[2], env = process.env) {
  const verified = assert005nCloudEnvironment(env, phase);
  const files = verifyRollbackArtifactFiles({
    artifact: verified.artifact,
    readFile: ({ runtimePath }) => fs.readFileSync(path.join(__dirname, runtimePath)),
  });
  await verifyHealth(verified.artifact, env.PORT);

  const result = {
    batch: '005n-cloudbase-rollback-control',
    status: 'PASS',
    phase,
    runId: verified.runId,
    role: verified.role,
    artifactId: verified.artifact.artifactId,
    sourceDigestsMatched: files.length === verified.artifact.source.files.length,
    healthPassed: true,
    revisionFingerprint: verified.currentFingerprint,
    revisionIdentitySource: verified.revisionIdentitySource,
    productionUserStoreRemainsSqlite: true,
    postgresNetworkUsed: false,
    postgresRowsMutated: false,
  };

  if (phase === 'baseline') {
    result.stableRevisionRecorded = true;
  } else if (phase === 'signal') {
    const policy = parsePostgresRollbackPolicy(env);
    const snapshot = createPostgresOperationalSnapshot({
      pool: { totalCount: 1, idleCount: 0, waitingCount: policy.waitingClients },
      poolMax: 1,
      counters: { sampleCount: policy.minSamples },
    });
    const signal = evaluatePostgresRollbackSignals(snapshot, policy);
    if (!signal.shouldRollback || signal.action !== 'rollback') {
      fail('ROLLBACK_SIGNAL_NOT_TRIGGERED');
    }
    result.canaryRevisionDistinct = true;
    result.rollbackSignal = signal.action;
    result.rollbackReasonCount = signal.reasons.length;
    result.controlPlaneActionRequired = true;
  } else {
    result.stableRevisionRestored = true;
    result.canaryRevisionReplaced = true;
    result.controlPlaneActionConfirmed = true;
  }

  console.log(JSON.stringify(result));
}

if (require.main === module) {
  run().catch((error) => {
    console.log(JSON.stringify({
      batch: '005n-cloudbase-rollback-control',
      status: 'FAIL',
      errorCode: error?.code || 'UNKNOWN',
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_PHASES,
  CONTROL_PLANE_CONFIRMATION,
  DEDICATED_CONFIRMATION,
  VERIFY_CONFIRMATION,
  assert005nCloudEnvironment,
  run,
};
