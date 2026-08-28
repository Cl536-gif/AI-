SELECT
  count(*) FILTER (WHERE status IN ('queued','processing','processed')) AS unfinished_jobs,
  count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_jobs,
  count(*) FILTER (WHERE status = 'state_conflict') AS conflict_jobs
FROM app.wecom_inbound_jobs;

SELECT
  count(*) FILTER (WHERE status IN ('queued','sending')) AS unsent_outbox,
  count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_outbox
FROM app.wecom_outbound_messages;
