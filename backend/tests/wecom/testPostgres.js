const fs = require('fs');
const assert = require('assert');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres');

const PG_BIN = process.env.TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@16/bin';

async function findPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startIsolatedPostgres({ checkpointSchema = 'wecom_test_checkpoint' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-pg-'));
  const dataDir = path.join(root, 'data');
  const socketDir = path.join(root, 'socket');
  const logFile = path.join(root, 'postgres.log');
  fs.mkdirSync(socketDir);
  const port = await findPort();
  execFileSync(path.join(PG_BIN, 'initdb'), [
    '-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8',
  ], { stdio: 'ignore' });
  execFileSync(path.join(PG_BIN, 'pg_ctl'), [
    '-D', dataDir, '-l', logFile, '-o', `-p ${port} -h 127.0.0.1 -k ${socketDir}`, '-w', 'start',
  ], { stdio: 'ignore' });
  const connectionString = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  const pool = new Pool({ connectionString, max: 12 });
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`
    CREATE ROLE diet_owner NOLOGIN;
    CREATE ROLE diet_app NOLOGIN;
    CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION diet_owner;
  `);
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../../sql/postgres/006a_wecom_async_channel.review.sql'),
    'utf8'
  );
  await pool.query(migration);
  const privilegeCheck = await pool.query(`
    WITH expected(table_name) AS (
      VALUES
        ('wecom_identities'), ('wecom_onboarding'), ('wecom_deletion_requests'),
        ('wecom_inbound_jobs'), ('wecom_graph_receipts'), ('wecom_outbound_messages')
    )
    SELECT
      count(*) FILTER (WHERE has_table_privilege(
        'diet_app', 'app.' || table_name, 'SELECT,INSERT,UPDATE'
      ))::integer AS table_count,
      has_sequence_privilege(
        'diet_app', 'app.wecom_inbound_jobs_sequence_id_seq', 'USAGE,SELECT'
      ) AS sequence_access
    FROM expected
    GROUP BY sequence_access
  `);
  assert.strictEqual(privilegeCheck.rows[0]?.table_count, 6);
  assert.strictEqual(privilegeCheck.rows[0]?.sequence_access, true);
  await pool.query(`
    CREATE TABLE app.wecom_test_crash_signals (
      scenario text PRIMARY KEY,
      request_id uuid NOT NULL,
      marker text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE app.wecom_test_model_attempts (
      attempt_id bigserial PRIMARY KEY,
      request_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE app.wecom_test_advice (
      operation_id uuid PRIMARY KEY,
      request_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const saver = new PostgresSaver(pool, undefined, { schema: checkpointSchema });
  await saver.setup();
  let stopped = false;
  return {
    root, dataDir, port, connectionString, pool, checkpointSchema,
    async stop() {
      if (stopped) return;
      stopped = true;
      await pool.end().catch(() => {});
      execFileSync(path.join(PG_BIN, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], {
        stdio: 'ignore',
      });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { PG_BIN, startIsolatedPostgres };
