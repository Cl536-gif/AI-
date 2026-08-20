-- Run after both sessions have committed.
WITH merge_row AS (
  SELECT merge_id, source_user_id, target_user_id, status, merged_at
  FROM app.user_merges
  WHERE source_user_id = 'anon:fkshare_20260818_190000_k7m2'
),
facts AS (
  SELECT
    (SELECT status FROM app.users
     WHERE user_id = 'anon:fkshare_20260818_190000_k7m2') AS source_status,
    (SELECT merged_into_user_id FROM app.users
     WHERE user_id = 'anon:fkshare_20260818_190000_k7m2') AS source_merged_into,
    (SELECT status FROM app.users
     WHERE user_id = 'acct:fkshare_20260818_190000_k7m2') AS target_status,
    (SELECT COUNT(*) FROM app.user_events
     WHERE user_id = 'anon:fkshare_20260818_190000_k7m2'
       AND event_id = 'fkshare_source_20260818_190000_k7m2') AS source_event_count,
    (SELECT COUNT(*) FROM app.user_events
     WHERE user_id = 'acct:fkshare_20260818_190000_k7m2'
       AND idempotency_key = 'fkshare-idempotency-20260818-190000-k7m2'
       AND event_type = 'check_in'
       AND payload = '{"concurrencyTest":"session-a-before-merge"}'::jsonb
       AND status = 'active') AS target_event_count,
    (SELECT COUNT(*)
     FROM app.event_merge_audit AS audit
     JOIN merge_row AS merge ON merge.merge_id = audit.merge_id
     WHERE audit.source_event_id = 'fkshare_source_20260818_190000_k7m2'
       AND audit.action = 'migrated') AS audit_count
)
SELECT
  CASE
    WHEN (SELECT COUNT(*) FROM merge_row) = 1
      AND source_status = 'merged'
      AND source_merged_into = 'acct:fkshare_20260818_190000_k7m2'
      AND target_status = 'active'
      AND source_event_count = 1
      AND target_event_count = 1
      AND audit_count = 1
    THEN 'PASS'
    ELSE 'FAIL'
  END AS status,
  (SELECT merge_id FROM merge_row) AS merge_id,
  (SELECT merged_at FROM merge_row) AS merged_at,
  source_status,
  source_merged_into,
  target_status,
  source_event_count,
  target_event_count,
  audit_count
FROM facts;
