const assert = require('assert');
const { execFileSync } = require('child_process');
const {
  assertRollbackArtifactDocument,
  assertRollbackEnvironment,
  loadRollbackArtifact,
  verifyRollbackArtifactFiles,
} = require('./src/release/sqliteRollbackArtifact');

const TAG_CONFIRMATION = 'CONFIRMED_005K_IMMUTABLE_ROLLBACK_TAG';
const artifact = loadRollbackArtifact();
const validEnv = {
  USER_STORE_ADAPTER: 'sqlite',
  LANGGRAPH_CHECKPOINTER_BACKEND: 'memory',
  NODE_ENV: 'production',
  PORT: '3001',
};

assert.strictEqual(assertRollbackEnvironment({ artifact, env: validEnv }).verified, true);
assert.throws(
  () => assertRollbackEnvironment({
    artifact,
    env: { ...validEnv, USER_STORE_ADAPTER: 'tencent-postgres' },
  }),
  (error) => error?.code === 'ROLLBACK_ENVIRONMENT_MISMATCH'
);
assert.throws(
  () => assertRollbackEnvironment({
    artifact,
    env: { ...validEnv, TENCENT_PG_CUTOVER_MODE: 'full' },
  }),
  (error) => error?.code === 'ROLLBACK_ENVIRONMENT_FORBIDDEN_VALUE'
);

const serialized = JSON.stringify(artifact);
assert(!/(password|api[_-]?key|credential|private[_-]?key)/i.test(serialized));
const broken = JSON.parse(serialized);
broken.dataBoundary.automaticPostgresDelete = true;
assert.throws(
  () => assertRollbackArtifactDocument(broken),
  (error) => error?.code === 'ROLLBACK_ARTIFACT_DATA_BOUNDARY_INVALID'
);

let tagVerified = false;
let sourceCommit = null;
if (process.env.RUN_005K_TAG_VERIFY === TAG_CONFIRMATION) {
  sourceCommit = execFileSync('git', ['rev-list', '-n', '1', artifact.source.gitTag], {
    encoding: 'utf8',
  }).trim();
  assert(/^[a-f0-9]{40}$/.test(sourceCommit));
  verifyRollbackArtifactFiles({
    artifact,
    readFile: ({ sourcePath }) => execFileSync(
      'git',
      ['show', `${artifact.source.gitTag}:${sourcePath}`]
    ),
  });
  tagVerified = true;
}

console.log(JSON.stringify({
  batch: '005k-sqlite-rollback-artifact',
  status: 'PASS',
  artifactId: artifact.artifactId,
  sourceFileCount: artifact.source.files.length,
  stableSqliteEnvironmentRequired: true,
  postgresCutoverValuesForbidden: true,
  dataBoundaryFailClosed: true,
  sensitiveValuesEmbedded: false,
  tagVerified,
  sourceCommitRecorded: Boolean(sourceCommit),
}));

module.exports = { TAG_CONFIRMATION };
