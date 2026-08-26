-- REVIEW ONLY: 005j PostgreSQL目标库逐表只读盘点。
-- 只返回表名和行数，不读取业务列、身份、正文或凭据。
BEGIN;
SET TRANSACTION READ ONLY;

SELECT inventory.table_name, inventory.row_count
FROM (
  SELECT 'users' AS table_name, count(*)::bigint AS row_count FROM app.users
  UNION ALL SELECT 'user_profiles', count(*) FROM app.user_profiles
  UNION ALL SELECT 'user_menstrual_profiles', count(*) FROM app.user_menstrual_profiles
  UNION ALL SELECT 'profile_revisions', count(*) FROM app.profile_revisions
  UNION ALL SELECT 'menstrual_profile_revisions', count(*) FROM app.menstrual_profile_revisions
  UNION ALL SELECT 'user_consents', count(*) FROM app.user_consents
  UNION ALL SELECT 'user_events', count(*) FROM app.user_events
  UNION ALL SELECT 'user_identities', count(*) FROM app.user_identities
  UNION ALL SELECT 'user_merges', count(*) FROM app.user_merges
  UNION ALL SELECT 'long_term_profile_confirmation_requests', count(*) FROM app.long_term_profile_confirmation_requests
  UNION ALL SELECT 'long_term_profile_field_confirmations', count(*) FROM app.long_term_profile_field_confirmations
  UNION ALL SELECT 'profile_merge_conflicts', count(*) FROM app.profile_merge_conflicts
  UNION ALL SELECT 'event_merge_audit', count(*) FROM app.event_merge_audit
  UNION ALL SELECT 'user_profile_versions', count(*) FROM app.user_profile_versions
  UNION ALL SELECT 'user_profile_version_history', count(*) FROM app.user_profile_version_history
  UNION ALL SELECT 'user_service_status', count(*) FROM app.user_service_status
  UNION ALL SELECT 'user_service_transitions', count(*) FROM app.user_service_transitions
  UNION ALL SELECT 'energy_calculations', count(*) FROM app.energy_calculations
  UNION ALL SELECT 'user_plan_versions', count(*) FROM app.user_plan_versions
  UNION ALL SELECT 'plan_state_transitions', count(*) FROM app.plan_state_transitions
  UNION ALL SELECT 'plan_revision_commands', count(*) FROM app.plan_revision_commands
  UNION ALL SELECT 'user_notifications', count(*) FROM app.user_notifications
  UNION ALL SELECT 'user_advice_history', count(*) FROM app.user_advice_history
) AS inventory
ORDER BY inventory.table_name;

ROLLBACK;
