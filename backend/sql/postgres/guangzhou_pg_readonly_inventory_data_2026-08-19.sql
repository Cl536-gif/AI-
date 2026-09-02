-- Guangzhou PostgreSQL read-only inventory: row counts and classification.
-- Safety/privacy contract: SELECT only; no profile JSON, event payload, consent
-- content, presented values, confirmed values or external identity hashes returned.

SELECT 'table_row_counts' AS section, table_name, row_count
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
  UNION ALL SELECT 'profile_merge_conflicts', count(*) FROM app.profile_merge_conflicts
  UNION ALL SELECT 'event_merge_audit', count(*) FROM app.event_merge_audit
  UNION ALL SELECT 'long_term_profile_confirmation_requests', count(*) FROM app.long_term_profile_confirmation_requests
  UNION ALL SELECT 'long_term_profile_field_confirmations', count(*) FROM app.long_term_profile_field_confirmations
) counts
ORDER BY table_name;

WITH classified_users AS (
  SELECT u.user_id,
         u.status,
         u.merged_into_user_id,
         u.created_at,
         u.updated_at,
         CASE
           WHEN u.user_id = 'migration_probe_user'
             OR u.user_id LIKE 'acct:merge_test_%'
             OR u.user_id LIKE 'acct:merge_other_%'
             OR u.user_id LIKE 'acct:merge_noeligible_%'
             OR u.user_id LIKE 'acct:merge_collision_%'
             OR u.user_id LIKE 'acct:merge_correction_collision_%'
             OR u.user_id LIKE 'acct:merge_failure_%'
             OR u.user_id IN (
               'anon:fkshare_20260818_190000_k7m2',
               'acct:fkshare_20260818_190000_k7m2'
             )
           THEN 'KNOWN_001_002_ACCEPTANCE_TEST'
           ELSE 'UNCONFIRMED_REVIEW_REQUIRED'
         END AS data_class
  FROM app.users u
)
SELECT 'users_classified' AS section,
       data_class,
       user_id,
       status,
       merged_into_user_id,
       created_at,
       updated_at
FROM classified_users
ORDER BY data_class, created_at, user_id;

SELECT 'identity_counts_without_hashes' AS section,
       identity_type,
       count(*)::bigint AS row_count,
       count(DISTINCT user_id)::bigint AS user_count,
       min(created_at) AS earliest_created_at,
       max(last_seen_at) AS latest_seen_at
FROM app.user_identities
GROUP BY identity_type
ORDER BY identity_type;

SELECT 'profile_metadata' AS section,
       'user_profiles' AS table_name,
       user_id,
       created_at,
       updated_at
FROM app.user_profiles
UNION ALL
SELECT 'profile_metadata' AS section,
       'user_menstrual_profiles' AS table_name,
       user_id,
       created_at,
       updated_at
FROM app.user_menstrual_profiles
ORDER BY table_name, created_at, user_id;

SELECT 'revision_metadata' AS section,
       'profile_revisions' AS table_name,
       revision_id,
       user_id,
       changed_at,
       source
FROM app.profile_revisions
UNION ALL
SELECT 'menstrual_profile_revisions', revision_id, user_id, changed_at, source
FROM app.menstrual_profile_revisions
ORDER BY table_name, changed_at, revision_id;

SELECT 'consent_metadata' AS section,
       consent_id,
       user_id,
       consent_type,
       status,
       recorded_at,
       created_at,
       source
FROM app.user_consents
ORDER BY recorded_at, consent_id;

SELECT 'event_metadata_without_payload' AS section,
       event_id,
       user_id,
       event_type,
       occurred_at,
       recorded_at,
       source,
       idempotency_key,
       supersedes_event_id,
       status
FROM app.user_events
ORDER BY recorded_at, event_id;

SELECT 'merge_metadata' AS section,
       merge_id,
       source_user_id,
       target_user_id,
       status,
       merged_at
FROM app.user_merges
ORDER BY merged_at, merge_id;

SELECT 'merge_audit_metadata_without_values' AS section,
       'profile_merge_conflicts' AS table_name,
       conflict_id::text AS record_id,
       merge_id,
       field_path AS record_type,
       resolution_status AS status,
       created_at
FROM app.profile_merge_conflicts
UNION ALL
SELECT 'event_merge_audit',
       audit_id::text,
       merge_id,
       action,
       action,
       created_at
FROM app.event_merge_audit
ORDER BY table_name, created_at, record_id;

SELECT 'confirmation_request_metadata_without_values' AS section,
       request_id,
       user_id,
       onboarding_session_id,
       prompt_turn_id,
       prompted_at,
       status,
       response_turn_id,
       responded_at,
       created_at,
       resolved_at
FROM app.long_term_profile_confirmation_requests
ORDER BY created_at, request_id;

SELECT 'field_confirmation_metadata_without_values' AS section,
       confirmation_id,
       user_id,
       field_path,
       profile_revision_id,
       confirmation_request_id,
       onboarding_session_id,
       confirmed_at,
       created_at
FROM app.long_term_profile_field_confirmations
ORDER BY created_at, confirmation_id;

SELECT 'known_acceptance_residue' AS section,
       (SELECT count(*) FROM app.users
        WHERE user_id = 'migration_probe_user'
           OR user_id LIKE 'acct:merge_test_%'
           OR user_id LIKE 'acct:merge_other_%'
           OR user_id LIKE 'acct:merge_noeligible_%'
           OR user_id LIKE 'acct:merge_collision_%'
           OR user_id LIKE 'acct:merge_correction_collision_%'
           OR user_id LIKE 'acct:merge_failure_%') AS scripted_test_users,
       (SELECT count(*) FROM app.users
        WHERE user_id IN ('anon:fkshare_20260818_190000_k7m2',
                          'acct:fkshare_20260818_190000_k7m2')) AS concurrency_test_users,
       (SELECT count(*) FROM app.user_events
        WHERE event_id = 'fkshare_source_20260818_190000_k7m2'
           OR user_id IN ('anon:fkshare_20260818_190000_k7m2',
                          'acct:fkshare_20260818_190000_k7m2')) AS concurrency_test_events,
       (SELECT count(*) FROM app.user_merges
        WHERE merge_id = 'f4e8e10e-8e8d-4f36-a286-2277dfaf860f'::uuid
           OR source_user_id = 'anon:fkshare_20260818_190000_k7m2'
           OR target_user_id = 'acct:fkshare_20260818_190000_k7m2') AS concurrency_test_merges;
