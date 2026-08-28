SELECT
  current_database() AS database_name,
  to_regclass('app.wecom_inbound_jobs') IS NULL AS migration_not_yet_applied,
  current_setting('transaction_read_only') AS transaction_read_only,
  to_regrole('diet_owner') IS NOT NULL AS owner_role_present,
  to_regrole('diet_app') IS NOT NULL AS runtime_role_present;
