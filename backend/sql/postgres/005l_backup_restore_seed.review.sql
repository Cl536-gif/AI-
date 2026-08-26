-- 005l fixed source marker written before selecting the PITR target.
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('app.backup_recovery_canary_005l') IS NOT NULL THEN
    RAISE EXCEPTION '005l恢复标记表已存在，拒绝覆盖';
  END IF;
END;
$$;

CREATE TABLE app.backup_recovery_canary_005l (
  run_key varchar(64) NOT NULL,
  phase varchar(16) NOT NULL CHECK (phase IN ('before', 'after')),
  marker_hash char(64) NOT NULL CHECK (marker_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_key, phase),
  CHECK (run_key = '005l-backup-restore-canary')
);

REVOKE ALL ON TABLE app.backup_recovery_canary_005l FROM PUBLIC;
GRANT SELECT ON TABLE app.backup_recovery_canary_005l TO diet_app, diet_owner;

INSERT INTO app.backup_recovery_canary_005l (run_key, phase, marker_hash)
VALUES (
  '005l-backup-restore-canary',
  'before',
  '33d595c554a767f6a3edacb73de00416859098d5d7714f2994834d7069e8e2ff'
);

SELECT
  'PASS' AS status,
  phase,
  created_at AS before_marker_at,
  marker_hash = '33d595c554a767f6a3edacb73de00416859098d5d7714f2994834d7069e8e2ff'
    AS marker_hash_matched
FROM app.backup_recovery_canary_005l
WHERE run_key = '005l-backup-restore-canary' AND phase = 'before';

COMMIT;
