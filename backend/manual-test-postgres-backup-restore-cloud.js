const crypto = require('crypto');
const { createPostgresPool } = require('./src/db/postgresPool');
const { parsePostgresPoolConfig } = require('./src/db/postgresPoolConfig');
const { checkPostgresReadiness } = require('./src/db/postgresReadiness');
const { isPrivateIpv4, normalizeErrorCode } = require('./src/db/postgresCloudVerification');
const {
  assertBackupRecoveryAllowed,
} = require('./src/db/postgresBackupRecoveryGate');

const BEFORE_HASH = '33d595c554a767f6a3edacb73de00416859098d5d7714f2994834d7069e8e2ff';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseInventory(env) {
  const values = {};
  for (const name of ['TABLE', 'FUNCTION', 'CONSTRAINT']) {
    const raw = String(env[`TENCENT_PG_005L_SOURCE_${name}_COUNT`] || '').trim();
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) fail(`SOURCE_${name}_COUNT_REQUIRED`);
    values[`${name.toLowerCase()}Count`] = Number(raw);
  }
  return Object.freeze(values);
}

function assert005lCloudEnvironment(env = process.env) {
  const gate = assertBackupRecoveryAllowed(env);
  const config = parsePostgresPoolConfig(env);
  if (!isPrivateIpv4(config.host)) fail('PRIVATE_IPV4_REQUIRED');
  if (config.port !== 5432) fail('POSTGRES_PORT_MUST_BE_5432');
  if (config.poolMax !== 1) fail('RESTORE_POOL_MAX_MUST_BE_ONE');
  if (sha256(config.host) === String(env.TENCENT_PG_SOURCE_HOST_SHA256).trim()) {
    fail('RESTORE_INSTANCE_NOT_ISOLATED');
  }
  return Object.freeze({
    ...gate,
    config,
    inventory: parseInventory(env),
  });
}

async function run(env = process.env) {
  const verified = assert005lCloudEnvironment(env);
  const pool = createPostgresPool({ config: verified.config });
  let client;
  let transactionOpen = false;
  try {
    await checkPostgresReadiness({ pool });
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    transactionOpen = true;
    const sslResult = await client.query(`
      SELECT ssl, version
      FROM pg_stat_ssl
      WHERE pid = pg_backend_pid()
    `);
    const ssl = sslResult.rows[0];
    if (!ssl?.ssl || !/^TLSv1\.(?:2|3)$/.test(String(ssl.version || ''))) {
      fail('TLS_SESSION_NOT_VERIFIED');
    }

    const markerResult = await client.query(`
      SELECT phase, marker_hash
      FROM app.backup_recovery_canary_005l
      WHERE run_key = $1
      ORDER BY phase
    `, ['005l-backup-restore-canary']);
    if (
      markerResult.rows.length !== 1
      || markerResult.rows[0].phase !== 'before'
      || markerResult.rows[0].marker_hash !== BEFORE_HASH
    ) {
      fail('PITR_MARKER_BOUNDARY_MISMATCH');
    }

    const inventoryResult = await client.query(`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables
         WHERE table_schema = 'app' AND table_type = 'BASE TABLE'
           AND table_name <> 'backup_recovery_canary_005l') AS table_count,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app') AS function_count,
        (SELECT count(*)::int FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname = 'app'
           AND c.conrelid <> 'app.backup_recovery_canary_005l'::regclass) AS constraint_count
    `);
    const inventory = inventoryResult.rows[0];
    if (
      inventory.table_count !== verified.inventory.tableCount
      || inventory.function_count !== verified.inventory.functionCount
      || inventory.constraint_count !== verified.inventory.constraintCount
    ) {
      fail('SCHEMA_INVENTORY_MISMATCH');
    }
    await client.query('ROLLBACK');
    transactionOpen = false;

    console.log(JSON.stringify({
      batch: '005l-postgres-backup-restore-cloud',
      status: 'PASS',
      restoreMode: 'point_in_time_isolated_clone',
      beforeMarkerRestored: true,
      afterMarkerExcluded: true,
      schemaInventoryMatched: true,
      tlsVerified: true,
      tlsVersion: ssl.version,
      observedRpoMinutes: verified.observation.observedRpoMinutes,
      observedRtoMinutes: verified.observation.observedRtoMinutes,
      rpoTargetMet: true,
      rtoTargetMet: true,
      sourceInstanceUntouched: true,
      restoredDataEmitted: false,
    }));
  } finally {
    if (client) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      batch: '005l-postgres-backup-restore-cloud',
      status: 'FAIL',
      errorCode: normalizeErrorCode(error, 'CONFIGURATION_ERROR'),
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  BEFORE_HASH,
  assert005lCloudEnvironment,
  run,
};
