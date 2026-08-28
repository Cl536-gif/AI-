SELECT
  count(*) FILTER (WHERE status IN ('queued','processing','processed')) AS unfinished_jobs,
  count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_jobs,
  count(*) FILTER (WHERE status = 'state_conflict') AS conflict_jobs
FROM app.wecom_inbound_jobs;

SELECT
  count(*) FILTER (WHERE status IN ('queued','sending')) AS unsent_outbox,
  count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_outbox
FROM app.wecom_outbound_messages;

WITH expected(table_name) AS (
  VALUES
    ('wecom_identities'),
    ('wecom_onboarding'),
    ('wecom_deletion_requests'),
    ('wecom_inbound_jobs'),
    ('wecom_graph_receipts'),
    ('wecom_outbound_messages')
)
SELECT
  count(*) AS expected_table_count,
  count(*) FILTER (WHERE to_regclass('app.' || table_name) IS NOT NULL) AS present_table_count,
  count(*) FILTER (WHERE has_table_privilege('diet_app', 'app.' || table_name,
    'SELECT,INSERT,UPDATE')) AS runtime_rw_table_count
FROM expected;

SELECT
  to_regclass('app.wecom_inbound_jobs_sequence_id_seq') IS NOT NULL AS sequence_present,
  has_sequence_privilege('diet_app', 'app.wecom_inbound_jobs_sequence_id_seq',
    'USAGE,SELECT') AS runtime_sequence_access;
