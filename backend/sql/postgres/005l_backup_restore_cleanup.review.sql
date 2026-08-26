-- Exact cleanup on the source database after the isolated clone has been verified.
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  matched integer;
BEGIN
  IF to_regclass('app.backup_recovery_canary_005l') IS NULL THEN
    RAISE EXCEPTION '005l恢复标记表不存在，拒绝模糊清理';
  END IF;
  SELECT count(*) INTO matched
  FROM app.backup_recovery_canary_005l
  WHERE run_key = '005l-backup-restore-canary'
    AND (
      (phase = 'before' AND marker_hash = '33d595c554a767f6a3edacb73de00416859098d5d7714f2994834d7069e8e2ff')
      OR
      (phase = 'after' AND marker_hash = '6aa84b68615c29d4892af9a3af6443920791ad894f3a89e6524c01cf0653ae28')
    );
  IF matched <> 2 OR (SELECT count(*) FROM app.backup_recovery_canary_005l) <> 2 THEN
    RAISE EXCEPTION '005l恢复标记内容不唯一，转人工审核';
  END IF;
END;
$$;

DROP TABLE app.backup_recovery_canary_005l;

SELECT
  'PASS' AS status,
  to_regclass('app.backup_recovery_canary_005l') IS NULL AS source_marker_removed;

COMMIT;
