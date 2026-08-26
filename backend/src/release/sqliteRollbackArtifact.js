const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_ARTIFACT_PATH = path.join(
  __dirname,
  '../../release/005k_sqlite_rollback_artifact.review.json'
);
const SECRET_NAME_PATTERN = /(secret|password|api[_-]?key|token|credential|private[_-]?key)/i;

function createRollbackArtifactError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRollbackArtifactDocument(artifact) {
  if (!isPlainObject(artifact) || artifact.schemaVersion !== 1) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_SCHEMA_INVALID', '回滚制品schema无效');
  }
  if (!/^005k-sqlite-rollback-v\d+$/.test(String(artifact.artifactId || ''))) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_ID_INVALID', '回滚制品ID无效');
  }
  if (!/^sqlite-rollback-005k-v\d+$/.test(String(artifact.source?.gitTag || ''))) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_TAG_INVALID', '回滚制品Git tag无效');
  }
  if (artifact.source?.buildContext !== 'backend' || !Array.isArray(artifact.source?.files)) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_SOURCE_INVALID', '回滚制品源码声明无效');
  }
  if (artifact.source.files.length < 3) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_SOURCE_INVALID', '回滚制品缺少构建输入');
  }
  const seen = new Set();
  for (const file of artifact.source.files) {
    if (
      !isPlainObject(file)
      || !/^backend\/[A-Za-z0-9._/-]+$/.test(String(file.sourcePath || ''))
      || !/^[A-Za-z0-9._/-]+$/.test(String(file.runtimePath || ''))
      || !/^[a-f0-9]{64}$/.test(String(file.sha256 || ''))
      || seen.has(file.sourcePath)
    ) {
      throw createRollbackArtifactError('ROLLBACK_ARTIFACT_SOURCE_INVALID', '回滚制品文件声明无效');
    }
    seen.add(file.sourcePath);
  }

  const required = artifact.environment?.required;
  const mustBeEmpty = artifact.environment?.mustBeEmpty;
  if (!isPlainObject(required) || !Array.isArray(mustBeEmpty)) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_ENV_INVALID', '回滚环境快照无效');
  }
  const expectedRequired = {
    USER_STORE_ADAPTER: 'sqlite',
    LANGGRAPH_CHECKPOINTER_BACKEND: 'memory',
    NODE_ENV: 'production',
    PORT: '3001',
  };
  if (JSON.stringify(required) !== JSON.stringify(expectedRequired)) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_ENV_INVALID', '回滚环境快照不是稳定SQLite配置');
  }
  for (const [name, value] of Object.entries(required)) {
    if (SECRET_NAME_PATTERN.test(name) || SECRET_NAME_PATTERN.test(String(value))) {
      throw createRollbackArtifactError('ROLLBACK_ARTIFACT_SECRET_FORBIDDEN', '回滚制品不得包含密钥');
    }
  }
  if (
    mustBeEmpty.length !== new Set(mustBeEmpty).size
    || mustBeEmpty.some((name) => typeof name !== 'string' || SECRET_NAME_PATTERN.test(name))
  ) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_ENV_INVALID', '回滚空值环境声明无效');
  }

  const health = artifact.health;
  if (
    !Array.isArray(health)
    || health.length !== 2
    || !health.some(({ path: value, expectedStatus }) => value === '/api/health' && expectedStatus === 200)
    || !health.some(({ path: value, expectedStatus }) => value === '/api/ready' && expectedStatus === 200)
  ) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_HEALTH_INVALID', '回滚健康检查声明无效');
  }

  const boundary = artifact.dataBoundary;
  if (
    !isPlainObject(boundary)
    || boundary.postgresWritesRemainAuthoritative !== true
    || boundary.automaticPostgresToSqliteCopy !== false
    || boundary.automaticPostgresDelete !== false
    || boundary.sqliteFileMutationAuthorized !== false
    || boundary.realTrafficRollbackRequiresWriteFreeze !== true
  ) {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_DATA_BOUNDARY_INVALID', '回滚数据边界无效');
  }
  return artifact;
}

function loadRollbackArtifact({ artifactPath = DEFAULT_ARTIFACT_PATH } = {}) {
  const document = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  return assertRollbackArtifactDocument(document);
}

function verifyRollbackArtifactFiles({ artifact, readFile }) {
  assertRollbackArtifactDocument(artifact);
  if (typeof readFile !== 'function') {
    throw createRollbackArtifactError('ROLLBACK_ARTIFACT_READER_REQUIRED', '缺少回滚制品文件读取器');
  }
  const verified = artifact.source.files.map((file) => {
    const contents = readFile(file);
    const actualSha256 = sha256(contents);
    if (actualSha256 !== file.sha256) {
      throw createRollbackArtifactError(
        'ROLLBACK_ARTIFACT_DIGEST_MISMATCH',
        `回滚制品构建输入摘要不匹配：${file.sourcePath}`
      );
    }
    return Object.freeze({ sourcePath: file.sourcePath, sha256: actualSha256 });
  });
  return Object.freeze(verified);
}

function assertRollbackEnvironment({ artifact, env = process.env } = {}) {
  assertRollbackArtifactDocument(artifact);
  for (const [name, expected] of Object.entries(artifact.environment.required)) {
    if (String(env[name] ?? '').trim().toLowerCase() !== expected.toLowerCase()) {
      throw createRollbackArtifactError(
        'ROLLBACK_ENVIRONMENT_MISMATCH',
        `${name}不符合稳定SQLite回滚快照`
      );
    }
  }
  for (const name of artifact.environment.mustBeEmpty) {
    if (String(env[name] ?? '').trim() !== '') {
      throw createRollbackArtifactError(
        'ROLLBACK_ENVIRONMENT_FORBIDDEN_VALUE',
        `${name}在SQLite回滚修订中必须为空`
      );
    }
  }
  return Object.freeze({
    artifactId: artifact.artifactId,
    gitTag: artifact.source.gitTag,
    adapter: 'sqlite',
    checkpointerBackend: 'memory',
    verified: true,
  });
}

module.exports = {
  DEFAULT_ARTIFACT_PATH,
  assertRollbackArtifactDocument,
  assertRollbackEnvironment,
  createRollbackArtifactError,
  loadRollbackArtifact,
  sha256,
  verifyRollbackArtifactFiles,
};
