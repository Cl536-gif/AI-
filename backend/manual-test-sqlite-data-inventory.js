const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  SQLITE_SOURCE_TABLES,
  inventorySqliteDatabase,
} = require('./src/migration/sqliteDataInventory');
const { run: runSourceAudit } = require('./manual-audit-sqlite-source');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '005j-sqlite-inventory-'));
const dbPath = path.join(tempDir, 'fixture.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (user_id TEXT PRIMARY KEY);
  CREATE TABLE user_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(user_id),
    profile_json TEXT NOT NULL
  );
  INSERT INTO users (user_id) VALUES ('anon:005j-fixture');
  INSERT INTO user_profiles (user_id, profile_json)
  VALUES ('anon:005j-fixture', '{"schemaVersion":1}');
`);
db.close();

try {
  assert.throws(
    () => runSourceAudit({}),
    (error) => error?.code === 'VERIFY_CONFIRMATION_REQUIRED'
  );
  const result = inventorySqliteDatabase({
    dbPath,
    expectedTables: ['users', 'user_profiles'],
    jsonColumns: { user_profiles: ['profile_json'] },
  });
  assert.strictEqual(result.sourceFilePresent, true);
  assert.strictEqual(result.actualTableCount, 2);
  assert.deepStrictEqual(result.missingTables, []);
  assert.deepStrictEqual(result.unexpectedTables, []);
  assert.deepStrictEqual(result.tableCounts, { users: 1, user_profiles: 1 });
  assert.strictEqual(result.totalRows, 2);
  assert.strictEqual(result.integrityResult, 'ok');
  assert.strictEqual(result.foreignKeyViolations, 0);
  assert.strictEqual(result.invalidJsonRows, 0);
  assert.deepStrictEqual(result.userNamespaceCounts, { anon: 1 });
  assert.deepStrictEqual(result.identityTypeCounts, {});
  assert.strictEqual(result.decision, 'MIGRATION_OR_EXPLICIT_DISCARD_REQUIRED');
  assert.strictEqual(result.rowContentEmitted, false);
  assert.strictEqual(SQLITE_SOURCE_TABLES.length, 17);

  const missingPath = path.join(tempDir, 'missing.sqlite');
  assert.throws(
    () => inventorySqliteDatabase({ dbPath: missingPath }),
    (error) => error?.code === 'SQLITE_SOURCE_NOT_FOUND'
  );

  const brokenDbPath = path.join(tempDir, 'broken.sqlite');
  const brokenDb = new DatabaseSync(brokenDbPath);
  brokenDb.exec(`
    CREATE TABLE users (user_id TEXT PRIMARY KEY);
    CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL);
    INSERT INTO users (user_id) VALUES ('anon:005j-broken');
    INSERT INTO user_profiles (user_id, profile_json) VALUES ('anon:005j-broken', 'not-json');
  `);
  brokenDb.close();
  const broken = inventorySqliteDatabase({
    dbPath: brokenDbPath,
    expectedTables: ['users', 'user_profiles'],
    jsonColumns: { user_profiles: ['profile_json'] },
  });
  assert.strictEqual(broken.invalidJsonRows, 1);
  assert.strictEqual(broken.decision, 'SOURCE_INTEGRITY_REPAIR_REQUIRED');

  const targetInventorySql = fs.readFileSync(
    path.join(__dirname, 'sql/postgres/005j_target_inventory.review.sql'),
    'utf8'
  );
  assert(targetInventorySql.includes('SET TRANSACTION READ ONLY'));
  assert(targetInventorySql.includes("SELECT 'users' AS table_name"));
  assert(targetInventorySql.includes("SELECT 'user_advice_history', count(*)"));
  assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(
    targetInventorySql.replace(/^--.*$/gm, '')
  ));

  console.log(JSON.stringify({
    batch: '005j-sqlite-data-inventory',
    status: 'PASS',
    sourceMissingRejected: true,
    explicitConfirmationRequired: true,
    nonEmptySourceRequiresDecision: true,
    invalidJsonRejected: true,
    targetInventoryReadOnly: true,
    rowContentEmitted: false,
  }));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
