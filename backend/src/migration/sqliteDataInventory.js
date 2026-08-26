const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SQLITE_PATH = path.join(__dirname, '..', '..', 'data', 'app.db');

const SQLITE_SOURCE_TABLES = Object.freeze([
  'users',
  'user_profiles',
  'profile_revisions',
  'user_events',
  'user_advice_history',
  'user_consents',
  'user_identities',
  'user_service_status',
  'user_service_transitions',
  'user_notifications',
  'user_merges',
  'profile_merge_conflicts',
  'event_merge_audit',
  'energy_calculations',
  'user_plan_versions',
  'plan_state_transitions',
  'plan_revision_commands',
]);

const SQLITE_JSON_COLUMNS = Object.freeze({
  user_profiles: Object.freeze(['profile_json']),
  profile_revisions: Object.freeze(['snapshot_json', 'changed_fields_json']),
  user_events: Object.freeze(['payload_json']),
  user_advice_history: Object.freeze(['metadata_json']),
  profile_merge_conflicts: Object.freeze(['account_value_json', 'guest_value_json']),
  energy_calculations: Object.freeze([
    'inputs_json',
    'assumptions_json',
    'outputs_json',
    'source_refs_json',
  ]),
  user_plan_versions: Object.freeze(['plan_json']),
});

function inventoryError(code, message) {
  return Object.assign(new Error(message), { code });
}

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw inventoryError('SQLITE_INVENTORY_IDENTIFIER_INVALID', 'SQLite盘点标识符不合法');
  }
  return `"${identifier}"`;
}

function getTableNames(db) {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function countRows(db, tableName) {
  return Number(db.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(tableName)}`).get().count);
}

function countInvalidJson(db, tableName, columnName) {
  return Number(db.prepare(`
    SELECT count(*) AS count
    FROM ${quoteIdentifier(tableName)}
    WHERE ${quoteIdentifier(columnName)} IS NULL
       OR json_valid(${quoteIdentifier(columnName)}) = 0
  `).get().count);
}

function inventorySqliteDatabase({
  dbPath = DEFAULT_SQLITE_PATH,
  expectedTables = SQLITE_SOURCE_TABLES,
  jsonColumns = SQLITE_JSON_COLUMNS,
} = {}) {
  const resolvedPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedPath)) {
    throw inventoryError('SQLITE_SOURCE_NOT_FOUND', 'SQLite源文件不存在');
  }

  const db = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const actualTables = getTableNames(db);
    const expectedSet = new Set(expectedTables);
    const actualSet = new Set(actualTables);
    const missingTables = expectedTables.filter((name) => !actualSet.has(name));
    const unexpectedTables = actualTables.filter((name) => !expectedSet.has(name));
    const tableCounts = {};
    for (const tableName of expectedTables) {
      tableCounts[tableName] = actualSet.has(tableName) ? countRows(db, tableName) : null;
    }

    const invalidJsonCounts = {};
    for (const [tableName, columns] of Object.entries(jsonColumns)) {
      if (!actualSet.has(tableName)) continue;
      for (const columnName of columns) {
        const key = `${tableName}.${columnName}`;
        invalidJsonCounts[key] = countInvalidJson(db, tableName, columnName);
      }
    }

    const integrityResult = String(db.prepare('PRAGMA integrity_check').get().integrity_check);
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    const nonEmptyTables = Object.entries(tableCounts)
      .filter(([, count]) => Number.isInteger(count) && count > 0)
      .map(([name]) => name);
    const totalRows = Object.values(tableCounts)
      .filter(Number.isInteger)
      .reduce((sum, count) => sum + count, 0);
    const invalidJsonRows = Object.values(invalidJsonCounts).reduce((sum, count) => sum + count, 0);
    const userNamespaceCounts = actualSet.has('users')
      ? Object.fromEntries(db.prepare(`
          SELECT
            CASE
              WHEN user_id LIKE 'anon:%' THEN 'anon'
              WHEN user_id LIKE 'acct:%' THEN 'acct'
              ELSE 'other'
            END AS namespace,
            count(*) AS count
          FROM users
          GROUP BY namespace
          ORDER BY namespace
        `).all().map((row) => [row.namespace, Number(row.count)]))
      : {};
    const identityTypeCounts = actualSet.has('user_identities')
      ? Object.fromEntries(db.prepare(`
          SELECT
            CASE
              WHEN identity_type = 'device' THEN 'device'
              WHEN identity_type = 'device_sha256' THEN 'device_sha256'
              ELSE 'other'
            END AS identity_type_category,
            count(*) AS count
          FROM user_identities
          GROUP BY identity_type_category
          ORDER BY identity_type_category
        `).all().map((row) => [row.identity_type_category, Number(row.count)]))
      : {};

    let decision = 'MIGRATION_OR_EXPLICIT_DISCARD_REQUIRED';
    if (missingTables.length > 0 || unexpectedTables.length > 0) {
      decision = 'SOURCE_SCHEMA_REVIEW_REQUIRED';
    } else if (integrityResult !== 'ok' || foreignKeyViolations > 0 || invalidJsonRows > 0) {
      decision = 'SOURCE_INTEGRITY_REPAIR_REQUIRED';
    } else if (totalRows === 0) {
      decision = 'EMPTY_START_ELIGIBLE';
    }

    return Object.freeze({
      sourceFilePresent: true,
      sourceFileBytes: fs.statSync(resolvedPath).size,
      expectedTableCount: expectedTables.length,
      actualTableCount: actualTables.length,
      missingTables: Object.freeze(missingTables),
      unexpectedTables: Object.freeze(unexpectedTables),
      tableCounts: Object.freeze(tableCounts),
      nonEmptyTables: Object.freeze(nonEmptyTables),
      totalRows,
      integrityResult,
      foreignKeyViolations,
      invalidJsonCounts: Object.freeze(invalidJsonCounts),
      invalidJsonRows,
      userNamespaceCounts: Object.freeze(userNamespaceCounts),
      identityTypeCounts: Object.freeze(identityTypeCounts),
      decision,
      rowContentEmitted: false,
    });
  } finally {
    db.close();
  }
}

module.exports = {
  DEFAULT_SQLITE_PATH,
  SQLITE_JSON_COLUMNS,
  SQLITE_SOURCE_TABLES,
  inventorySqliteDatabase,
};
