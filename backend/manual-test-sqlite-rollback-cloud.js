const fs = require('fs');
const path = require('path');
const {
  assertRollbackEnvironment,
  loadRollbackArtifact,
  sha256,
  verifyRollbackArtifactFiles,
} = require('./src/release/sqliteRollbackArtifact');

const VERIFY_CONFIRMATION = 'CONFIRMED_005K_SQLITE_ROLLBACK_CLOUD';
const DEDICATED_CONFIRMATION = 'CONFIRMED_005K_DEDICATED_ROLLBACK_SERVICE';
const ALLOWED_PHASES = new Set(['baseline', 'rollback']);

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function assert005kCloudEnvironment(env = process.env, phase) {
  if (String(env.RUN_005K_ROLLBACK_VERIFY || '').trim() !== VERIFY_CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.RUN_005K_DEDICATED_SERVICE || '').trim() !== DEDICATED_CONFIRMATION) {
    fail('DEDICATED_SERVICE_REQUIRED');
  }
  if (!ALLOWED_PHASES.has(phase)) fail('ROLLBACK_PHASE_UNSUPPORTED');
  const artifact = loadRollbackArtifact();
  const environment = assertRollbackEnvironment({ artifact, env });
  return Object.freeze({ artifact, environment, phase });
}

function resolveCloudRevisionIdentity(env = process.env) {
  const kRevision = String(env.K_REVISION || '').trim();
  if (kRevision) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,252}$/.test(kRevision)) {
      fail('CLOUD_REVISION_ID_INVALID');
    }
    return Object.freeze({ value: kRevision, source: 'k_revision' });
  }
  const hostname = String(env.HOSTNAME || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{6,252}-[a-z0-9]{5}$/.test(hostname)) {
    fail('CLOUD_REVISION_ID_REQUIRED');
  }
  const revisionIdentity = hostname.replace(/-[a-z0-9]{5}$/, '');
  if (revisionIdentity.length < 3) fail('CLOUD_REVISION_ID_REQUIRED');
  return Object.freeze({ value: revisionIdentity, source: 'cloudbase_hostname' });
}

async function fetchLocal(pathname, port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

async function run(phase = process.argv[2]) {
  const verified = assert005kCloudEnvironment(process.env, phase);
  const files = verifyRollbackArtifactFiles({
    artifact: verified.artifact,
    readFile: ({ runtimePath }) => fs.readFileSync(path.join(__dirname, runtimePath)),
  });
  const healthResults = [];
  for (const check of verified.artifact.health) {
    const result = await fetchLocal(check.path, process.env.PORT);
    if (result.status !== check.expectedStatus) fail('ROLLBACK_HEALTH_CHECK_FAILED');
    healthResults.push({ path: check.path, status: result.status });
  }
  const revision = resolveCloudRevisionIdentity(process.env);

  console.log(JSON.stringify({
    batch: '005k-sqlite-rollback-cloud',
    status: 'PASS',
    phase,
    artifactId: verified.artifact.artifactId,
    sourceFileCount: files.length,
    sourceDigestsMatched: true,
    adapter: verified.environment.adapter,
    checkpointerBackend: verified.environment.checkpointerBackend,
    healthPassed: healthResults.every(({ status }) => status === 200),
    revisionFingerprint: sha256(revision.value),
    revisionIdentitySource: revision.source,
    postgresNetworkUsed: false,
    postgresRowsMutated: false,
  }));
}

if (require.main === module) {
  run().catch((error) => {
    console.log(JSON.stringify({
      batch: '005k-sqlite-rollback-cloud',
      status: 'FAIL',
      errorCode: error?.code || 'UNKNOWN',
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_PHASES,
  DEDICATED_CONFIRMATION,
  VERIFY_CONFIRMATION,
  assert005kCloudEnvironment,
  resolveCloudRevisionIdentity,
};
