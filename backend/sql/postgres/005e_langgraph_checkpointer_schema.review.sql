-- 005e LangGraph PostgreSQL checkpointer schema candidate.
-- Review and execute in DMS with the database owner. Do not run from application startup.
-- Mirrors the five migrations shipped by @langchain/langgraph-checkpoint-postgres@1.0.4,
-- then applies explicit ownership and least-privilege runtime grants.

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diet_owner') THEN
    RAISE EXCEPTION '005e缺少diet_owner角色';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diet_app') THEN
    RAISE EXCEPTION '005e缺少diet_app角色';
  END IF;
END
$preflight$;

CREATE SCHEMA IF NOT EXISTS langgraph_checkpoint AUTHORIZATION diet_owner;
ALTER SCHEMA langgraph_checkpoint OWNER TO diet_owner;

CREATE TABLE IF NOT EXISTS langgraph_checkpoint.checkpoint_migrations (
  v INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS langgraph_checkpoint.checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS langgraph_checkpoint.checkpoint_blobs (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  blob BYTEA,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS langgraph_checkpoint.checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  blob BYTEA NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

ALTER TABLE langgraph_checkpoint.checkpoint_migrations OWNER TO diet_owner;
ALTER TABLE langgraph_checkpoint.checkpoints OWNER TO diet_owner;
ALTER TABLE langgraph_checkpoint.checkpoint_blobs OWNER TO diet_owner;
ALTER TABLE langgraph_checkpoint.checkpoint_writes OWNER TO diet_owner;

INSERT INTO langgraph_checkpoint.checkpoint_migrations (v)
SELECT migration_version
FROM generate_series(0, 4) AS migration_version
ON CONFLICT (v) DO NOTHING;

REVOKE ALL ON SCHEMA langgraph_checkpoint FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA langgraph_checkpoint FROM PUBLIC;
GRANT USAGE ON SCHEMA langgraph_checkpoint TO diet_app;
GRANT SELECT ON langgraph_checkpoint.checkpoint_migrations TO diet_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON langgraph_checkpoint.checkpoints,
     langgraph_checkpoint.checkpoint_blobs,
     langgraph_checkpoint.checkpoint_writes
  TO diet_app;

COMMENT ON SCHEMA langgraph_checkpoint IS
  'LangGraph 1.4.8 shared checkpoints using the official PostgreSQL saver 1.0.4';
COMMENT ON COLUMN langgraph_checkpoint.checkpoints.thread_id IS
  'Opaque HMAC-scoped key; never a raw client thread identifier or user identifier';

DO $verify$
DECLARE
  table_count INTEGER;
  migration_count INTEGER;
  public_table_privileges INTEGER;
  app_forbidden_privileges INTEGER;
BEGIN
  SELECT count(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'langgraph_checkpoint'
    AND table_name IN (
      'checkpoint_migrations',
      'checkpoints',
      'checkpoint_blobs',
      'checkpoint_writes'
    );

  SELECT count(*) INTO migration_count
  FROM langgraph_checkpoint.checkpoint_migrations
  WHERE v BETWEEN 0 AND 4;

  SELECT count(*) INTO public_table_privileges
  FROM information_schema.role_table_grants
  WHERE table_schema = 'langgraph_checkpoint'
    AND grantee = 'PUBLIC';

  SELECT count(*) INTO app_forbidden_privileges
  FROM information_schema.role_table_grants
  WHERE table_schema = 'langgraph_checkpoint'
    AND grantee = 'diet_app'
    AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES');

  IF table_count <> 4
    OR migration_count <> 5
    OR public_table_privileges <> 0
    OR app_forbidden_privileges <> 0 THEN
    RAISE EXCEPTION '005e LangGraph checkpointer schema验证失败';
  END IF;
END
$verify$;

COMMIT;

SELECT
  'PASS' AS status,
  (SELECT count(*) = 4
   FROM information_schema.tables
   WHERE table_schema = 'langgraph_checkpoint'
     AND table_name IN (
       'checkpoint_migrations',
       'checkpoints',
       'checkpoint_blobs',
       'checkpoint_writes'
     )) AS four_tables_present,
  (SELECT count(*) = 5
   FROM langgraph_checkpoint.checkpoint_migrations
   WHERE v BETWEEN 0 AND 4) AS five_migrations_recorded,
  (SELECT count(*)
   FROM information_schema.role_table_grants
   WHERE table_schema = 'langgraph_checkpoint'
     AND grantee = 'PUBLIC') AS public_table_privileges,
  (SELECT count(*)
   FROM information_schema.role_table_grants
   WHERE table_schema = 'langgraph_checkpoint'
     AND grantee = 'diet_app'
     AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')) AS app_forbidden_privileges;
