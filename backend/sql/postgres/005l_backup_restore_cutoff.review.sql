-- Run after the before marker is durable. The midpoint is the PITR target.
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  before_count integer;
  after_count integer;
BEGIN
  IF to_regclass('app.backup_recovery_canary_005l') IS NULL THEN
    RAISE EXCEPTION '005l恢复标记表不存在';
  END IF;
  SELECT count(*) FILTER (WHERE phase = 'before'), count(*) FILTER (WHERE phase = 'after')
    INTO before_count, after_count
  FROM app.backup_recovery_canary_005l
  WHERE run_key = '005l-backup-restore-canary';
  IF before_count <> 1 OR after_count <> 0 THEN
    RAISE EXCEPTION '005l恢复标记状态不唯一，拒绝写入截止标记';
  END IF;
END;
$$;

INSERT INTO app.backup_recovery_canary_005l (run_key, phase, marker_hash)
VALUES (
  '005l-backup-restore-canary',
  'after',
  '6aa84b68615c29d4892af9a3af6443920791ad894f3a89e6524c01cf0653ae28'
);

SELECT
  'PASS' AS status,
  min(created_at) FILTER (WHERE phase = 'before') AS before_marker_at,
  max(created_at) FILTER (WHERE phase = 'after') AS after_marker_at,
  min(created_at) FILTER (WHERE phase = 'before')
    + (max(created_at) FILTER (WHERE phase = 'after')
       - min(created_at) FILTER (WHERE phase = 'before')) / 2
    AS recommended_recovery_target_at,
  max(created_at) FILTER (WHERE phase = 'after') AS failure_observed_at,
  count(*) = 2 AS marker_pair_complete
FROM app.backup_recovery_canary_005l
WHERE run_key = '005l-backup-restore-canary';

COMMIT;
