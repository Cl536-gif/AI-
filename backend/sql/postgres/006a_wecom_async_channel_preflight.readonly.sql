SELECT
  current_database() AS database_name,
  to_regclass('app.wecom_inbound_jobs') IS NULL AS migration_not_yet_applied,
  current_setting('transaction_read_only') AS transaction_read_only;
