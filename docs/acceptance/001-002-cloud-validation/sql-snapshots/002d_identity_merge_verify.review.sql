-- REVIEW ONLY: 002 身份合并批次的结构审计与真实行为验证。
-- 前置：002a、002b、002c 均已通过审核并成功提交。
-- 所有行为测试在同一事务中运行，末尾 ROLLBACK，不留测试数据。

-- A. 只读结构审计：预期全部 PASS。
WITH expected_tables(table_name) AS (
  VALUES
    ('user_identities'),
    ('user_merges'),
    ('long_term_profile_confirmation_requests'),
    ('long_term_profile_field_confirmations'),
    ('profile_merge_conflicts'),
    ('event_merge_audit')
),
expected_functions(signature, expected_definer, diet_app_execute) AS (
  VALUES
    ('app.current_user_is_active()', true, true),
    ('app.enforce_active_user_write()', true, false),
    ('app.enforce_consumed_profile_confirmation_request()', true, false),
    ('app.enforce_profile_confirmation_request_transition()', true, false),
    ('app.enforce_append_only_profile_confirmation()', true, false),
    ('app.resolve_anonymous_identity(character varying,character varying)', true, true),
    ('app.begin_current_long_term_profile_confirmation(character varying,character varying,jsonb,timestamp with time zone)', true, true),
    ('app.save_current_long_term_profile_fields(jsonb,jsonb,uuid,character varying,timestamp with time zone)', true, true),
    ('app.merge_current_account_from_anonymous(character varying)', true, true),
    ('app.get_current_user_merge(character varying)', true, true),
    ('app.get_current_merge_review(uuid)', true, true),
    ('app.release_current_merged_sensitive_events(uuid)', true, true),
    ('app.merge_value_is_blank(jsonb)', false, false),
    ('app.profile_snapshot_for_merge(character varying)', true, false),
    ('app.user_event_merge_fingerprint(character varying,timestamp with time zone,jsonb,character varying)', false, false)
),
expected_triggers(table_name, trigger_name, function_signature) AS (
  VALUES
    ('user_profiles', 'user_profiles_require_active_user', 'app.enforce_active_user_write()'),
    ('user_menstrual_profiles', 'menstrual_profiles_require_active_user', 'app.enforce_active_user_write()'),
    ('profile_revisions', 'profile_revisions_require_active_user', 'app.enforce_active_user_write()'),
    ('long_term_profile_confirmation_requests', 'long_term_profile_requests_require_active_user', 'app.enforce_active_user_write()'),
    ('long_term_profile_confirmation_requests', 'long_term_profile_requests_enforce_transition', 'app.enforce_profile_confirmation_request_transition()'),
    ('long_term_profile_field_confirmations', 'long_term_profile_confirmations_require_active_user', 'app.enforce_active_user_write()'),
    ('long_term_profile_field_confirmations', 'long_term_profile_confirmations_require_consumed_request', 'app.enforce_consumed_profile_confirmation_request()'),
    ('long_term_profile_field_confirmations', 'long_term_profile_confirmations_append_only', 'app.enforce_append_only_profile_confirmation()'),
    ('menstrual_profile_revisions', 'menstrual_revisions_require_active_user', 'app.enforce_active_user_write()'),
    ('user_consents', 'user_consents_require_active_user', 'app.enforce_active_user_write()'),
    ('user_events', 'user_events_require_active_user', 'app.enforce_active_user_write()')
),
expected_no_force_tables(table_name) AS (
  VALUES
    ('users'),
    ('user_profiles'),
    ('user_menstrual_profiles'),
    ('profile_revisions'),
    ('menstrual_profile_revisions'),
    ('user_consents'),
    ('user_events'),
    ('user_identities'),
    ('user_merges'),
    ('long_term_profile_confirmation_requests'),
    ('long_term_profile_field_confirmations'),
    ('profile_merge_conflicts'),
    ('event_merge_audit')
),
expected_constraints(table_name, constraint_name, constraint_type) AS (
  VALUES
    ('long_term_profile_confirmation_requests', 'long_term_profile_requests_lifecycle_chk', 'c'),
    ('long_term_profile_confirmation_requests', 'long_term_profile_requests_user_request_unique', 'u'),
    ('long_term_profile_confirmation_requests', 'long_term_profile_requests_prompt_unique', 'u'),
    ('long_term_profile_confirmation_requests', 'long_term_profile_requests_response_unique', 'u'),
    ('long_term_profile_field_confirmations', 'long_term_profile_confirmations_revision_fk', 'f'),
    ('long_term_profile_field_confirmations', 'long_term_profile_confirmations_request_fk', 'f'),
    ('long_term_profile_field_confirmations', 'long_term_profile_confirmations_request_field_unique', 'u')
),
expected_policies(table_name, policy_name) AS (
  VALUES
    ('users', 'users_select_own'),
    ('users', 'users_insert_own_active'),
    ('user_profiles', 'user_profiles_select_own'),
    ('user_profiles', 'user_profiles_insert_own'),
    ('user_profiles', 'user_profiles_update_own'),
    ('profile_revisions', 'profile_revisions_select_own'),
    ('profile_revisions', 'profile_revisions_insert_own'),
    ('user_menstrual_profiles', 'user_menstrual_profiles_select_own_consented'),
    ('user_menstrual_profiles', 'user_menstrual_profiles_insert_own_consented'),
    ('user_menstrual_profiles', 'user_menstrual_profiles_update_own_consented'),
    ('menstrual_profile_revisions', 'menstrual_profile_revisions_select_own_consented'),
    ('menstrual_profile_revisions', 'menstrual_profile_revisions_insert_own_consented'),
    ('user_consents', 'user_consents_select_own'),
    ('user_consents', 'user_consents_insert_own'),
    ('user_events', 'user_events_select_own'),
    ('user_events', 'user_events_insert_own')
),
checks AS (
  SELECT
    10 AS sort_order,
    'table: app.' || e.table_name AS item,
    CASE
      WHEN c.oid IS NOT NULL
       AND owner_role.rolname = 'diet_owner'
       AND c.relrowsecurity
       AND NOT c.relforcerowsecurity
       AND NOT EXISTS (
         SELECT 1 FROM pg_policy AS policy WHERE policy.polrelid = c.oid
       )
       AND NOT has_table_privilege('diet_app', c.oid, 'SELECT')
       AND NOT has_table_privilege('diet_app', c.oid, 'INSERT')
       AND NOT has_table_privilege('diet_app', c.oid, 'UPDATE')
       AND NOT has_table_privilege('diet_app', c.oid, 'DELETE')
       AND NOT has_table_privilege('public', c.oid, 'SELECT')
       AND NOT has_table_privilege('public', c.oid, 'INSERT')
       AND NOT has_table_privilege('public', c.oid, 'UPDATE')
       AND NOT has_table_privilege('public', c.oid, 'DELETE')
      THEN 'PASS' ELSE 'FAIL'
    END AS status,
    format(
      'exists=%s, owner=%s, rls=%s, force_rls=%s, policies=%s, diet_app_select=%s, diet_app_insert=%s, diet_app_update=%s, diet_app_delete=%s, public_select=%s, public_insert=%s, public_update=%s, public_delete=%s',
      c.oid IS NOT NULL,
      COALESCE(owner_role.rolname, 'missing'),
      COALESCE(c.relrowsecurity, false),
      COALESCE(c.relforcerowsecurity, false),
      (SELECT COUNT(*) FROM pg_policy AS policy WHERE policy.polrelid = c.oid),
      COALESCE(has_table_privilege('diet_app', c.oid, 'SELECT'), false),
      COALESCE(has_table_privilege('diet_app', c.oid, 'INSERT'), false),
      COALESCE(has_table_privilege('diet_app', c.oid, 'UPDATE'), false),
      COALESCE(has_table_privilege('diet_app', c.oid, 'DELETE'), false),
      COALESCE(has_table_privilege('public', c.oid, 'SELECT'), false),
      COALESCE(has_table_privilege('public', c.oid, 'INSERT'), false),
      COALESCE(has_table_privilege('public', c.oid, 'UPDATE'), false),
      COALESCE(has_table_privilege('public', c.oid, 'DELETE'), false)
    ) AS details
  FROM expected_tables AS e
  LEFT JOIN pg_namespace AS n ON n.nspname = 'app'
  LEFT JOIN pg_class AS c
    ON c.relnamespace = n.oid
   AND c.relname = e.table_name
   AND c.relkind = 'r'
  LEFT JOIN pg_roles AS owner_role ON owner_role.oid = c.relowner

  UNION ALL

  SELECT
    20,
    'column: app.user_events.status',
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'user_events'
          AND column_name = 'status'
          AND is_nullable = 'NO'
      )
      THEN 'PASS' ELSE 'FAIL'
    END,
    COALESCE(
      (
        SELECT format('type=%s, nullable=%s, default=%s', data_type, is_nullable, column_default)
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'user_events'
          AND column_name = 'status'
      ),
      'missing'
    )

  UNION ALL

  SELECT
    21,
    'column: app.user_consents.created_at',
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'user_consents'
          AND column_name = 'created_at'
          AND data_type = 'timestamp with time zone'
          AND is_nullable = 'NO'
          AND column_default IS NOT NULL
      )
      THEN 'PASS' ELSE 'FAIL'
    END,
    COALESCE(
      (
        SELECT format('type=%s, nullable=%s, default=%s', data_type, is_nullable, column_default)
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name = 'user_consents'
          AND column_name = 'created_at'
      ),
      'missing'
    )

  UNION ALL

  SELECT
    30,
    'function: ' || ef.signature,
    CASE
      WHEN p.oid IS NOT NULL
       AND owner_role.rolname = 'diet_owner'
       AND p.prosecdef = ef.expected_definer
       AND COALESCE(has_function_privilege('diet_app', p.oid, 'EXECUTE'), false)
           = ef.diet_app_execute
       AND NOT COALESCE(has_function_privilege('public', p.oid, 'EXECUTE'), false)
      THEN 'PASS' ELSE 'FAIL'
    END,
    format(
      'exists=%s, owner=%s, security_definer=%s, diet_app_execute=%s, public_execute=%s',
      p.oid IS NOT NULL,
      COALESCE(owner_role.rolname, 'missing'),
      COALESCE(p.prosecdef, false),
      COALESCE(has_function_privilege('diet_app', p.oid, 'EXECUTE'), false),
      COALESCE(has_function_privilege('public', p.oid, 'EXECUTE'), false)
    )
  FROM expected_functions AS ef
  LEFT JOIN pg_proc AS p ON p.oid = to_regprocedure(ef.signature)
  LEFT JOIN pg_roles AS owner_role ON owner_role.oid = p.proowner

  UNION ALL

  SELECT
    35,
    'trigger: app.' || et.table_name || '.' || et.trigger_name,
    CASE
      WHEN trg.oid IS NOT NULL
       AND trg.tgenabled IN ('O', 'A')
       AND trg.tgfoid = to_regprocedure(et.function_signature)
      THEN 'PASS' ELSE 'FAIL'
    END,
    format(
      'exists=%s, enabled=%s, function=%s',
      trg.oid IS NOT NULL,
      COALESCE(trg.tgenabled::text, 'missing'),
      COALESCE(trg.tgfoid::regprocedure::text, 'missing')
    )
  FROM expected_triggers AS et
  LEFT JOIN pg_namespace AS n ON n.nspname = 'app'
  LEFT JOIN pg_class AS c
    ON c.relnamespace = n.oid
   AND c.relname = et.table_name
   AND c.relkind = 'r'
  LEFT JOIN pg_trigger AS trg
    ON trg.tgrelid = c.oid
   AND trg.tgname = et.trigger_name
   AND NOT trg.tgisinternal

  UNION ALL

  SELECT
    36,
    'rls owner bypass required by controlled RPC: app.' || expected.table_name,
    CASE
      WHEN table_info.oid IS NOT NULL
       AND table_info.relrowsecurity
       AND NOT table_info.relforcerowsecurity
      THEN 'PASS' ELSE 'FAIL'
    END,
    format(
      'exists=%s, rls=%s, force_rls=%s',
      table_info.oid IS NOT NULL,
      COALESCE(table_info.relrowsecurity, false),
      COALESCE(table_info.relforcerowsecurity, false)
    )
  FROM expected_no_force_tables AS expected
  LEFT JOIN pg_namespace AS n ON n.nspname = 'app'
  LEFT JOIN pg_class AS table_info
    ON table_info.relnamespace = n.oid
   AND table_info.relname = expected.table_name
   AND table_info.relkind = 'r'

  UNION ALL

  SELECT
    37,
    'function body: enforce_active_user_write uses FOR KEY SHARE',
    CASE
      WHEN position(
        'FOR KEY SHARE' IN upper(COALESCE(p.prosrc, ''))
      ) > 0 THEN 'PASS' ELSE 'FAIL'
    END,
    format(
      'exists=%s, contains_for_key_share=%s',
      p.oid IS NOT NULL,
      position('FOR KEY SHARE' IN upper(COALESCE(p.prosrc, ''))) > 0
    )
  FROM (SELECT to_regprocedure('app.enforce_active_user_write()') AS oid) AS expected
  LEFT JOIN pg_proc AS p ON p.oid = expected.oid

  UNION ALL

  SELECT
    38,
    'constraint: app.' || expected.table_name || '.' || expected.constraint_name,
    CASE
      WHEN constraint_info.oid IS NOT NULL
       AND constraint_info.contype::text = expected.constraint_type
       AND constraint_info.convalidated
      THEN 'PASS' ELSE 'FAIL'
    END,
    format(
      'exists=%s, type=%s, validated=%s',
      constraint_info.oid IS NOT NULL,
      COALESCE(constraint_info.contype::text, 'missing'),
      COALESCE(constraint_info.convalidated, false)
    )
  FROM expected_constraints AS expected
  LEFT JOIN pg_namespace AS n ON n.nspname = 'app'
  LEFT JOIN pg_class AS table_info
    ON table_info.relnamespace = n.oid
   AND table_info.relname = expected.table_name
   AND table_info.relkind = 'r'
  LEFT JOIN pg_constraint AS constraint_info
    ON constraint_info.conrelid = table_info.oid
   AND constraint_info.conname = expected.constraint_name

  UNION ALL

  SELECT
    39,
    'index: app.long_term_profile_requests_one_pending_idx',
    CASE
      WHEN index_info.indexrelid IS NOT NULL
       AND index_info.indisunique
       AND index_info.indpred IS NOT NULL
      THEN 'PASS' ELSE 'FAIL'
    END,
    format(
      'exists=%s, unique=%s, partial=%s',
      index_info.indexrelid IS NOT NULL,
      COALESCE(index_info.indisunique, false),
      index_info.indpred IS NOT NULL
    )
  FROM (
    SELECT to_regclass('app.long_term_profile_requests_one_pending_idx') AS oid
  ) AS expected
  LEFT JOIN pg_index AS index_info ON index_info.indexrelid = expected.oid

  UNION ALL

  SELECT
    39,
    'policy: app.' || expected.table_name || '.' || expected.policy_name,
    CASE WHEN policy.polname IS NOT NULL THEN 'PASS' ELSE 'FAIL' END,
    format(
      'exists=%s, command=%s, permissive=%s',
      policy.polname IS NOT NULL,
      COALESCE(policy.polcmd::text, 'missing'),
      COALESCE(policy.polpermissive, false)
    )
  FROM expected_policies AS expected
  LEFT JOIN pg_namespace AS n ON n.nspname = 'app'
  LEFT JOIN pg_class AS table_info
    ON table_info.relnamespace = n.oid
   AND table_info.relname = expected.table_name
   AND table_info.relkind = 'r'
  LEFT JOIN pg_policy AS policy
    ON policy.polrelid = table_info.oid
   AND policy.polname = expected.policy_name

  UNION ALL

  SELECT
    39,
    'policy set: no unexpected policy on existing business tables',
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    format(
      'unexpected_count=%s, names=%s',
      COUNT(*),
      COALESCE(string_agg(policy.polname, ',' ORDER BY policy.polname), 'none')
    )
  FROM pg_policy AS policy
  JOIN pg_class AS table_info ON table_info.oid = policy.polrelid
  JOIN pg_namespace AS n
    ON n.oid = table_info.relnamespace
   AND n.nspname = 'app'
  WHERE table_info.relname IN (
    'users', 'user_profiles', 'profile_revisions',
    'user_menstrual_profiles', 'menstrual_profile_revisions',
    'user_consents', 'user_events'
  )
    AND NOT EXISTS (
      SELECT 1
      FROM expected_policies AS expected
      WHERE expected.table_name = table_info.relname
        AND expected.policy_name = policy.polname
    )

  UNION ALL

  SELECT
    39,
    'index: app.user_consents_user_created_idx',
    CASE
      WHEN index_info.indexrelid IS NOT NULL
       AND NOT index_info.indisunique
       AND index_info.indpred IS NULL
      THEN 'PASS' ELSE 'FAIL'
    END,
    format(
      'exists=%s, unique=%s, partial=%s',
      index_info.indexrelid IS NOT NULL,
      COALESCE(index_info.indisunique, false),
      index_info.indpred IS NOT NULL
    )
  FROM (
    SELECT to_regclass('app.user_consents_user_created_idx') AS oid
  ) AS expected
  LEFT JOIN pg_index AS index_info ON index_info.indexrelid = expected.oid

  UNION ALL

  SELECT
    40,
    'pending conflict backlog query',
    'PASS',
    format(
      'pending=%s, oldest=%s',
      COUNT(*) FILTER (WHERE resolution_status = 'pending'),
      COALESCE(
        MIN(created_at) FILTER (WHERE resolution_status = 'pending')::text,
        'none'
      )
    )
  FROM app.profile_merge_conflicts
)
SELECT item, status, details
FROM checks
ORDER BY sort_order, item;

-- B. 主行为、安全边界和后段故障回滚测试。
BEGIN;

-- NULL 与非法摘要必须在创建任何用户前被拒绝。
DO $test$
BEGIN
  BEGIN
    PERFORM app.resolve_anonymous_identity(NULL, repeat('a', 64));
    RAISE EXCEPTION 'NULL identity_type was unexpectedly accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM app.resolve_anonymous_identity('device_sha256', NULL);
    RAISE EXCEPTION 'NULL external_subject_hash was unexpectedly accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$test$;

SELECT set_config(
  'app.test_identity_hash',
  encode(public.digest(convert_to(public.gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'),
  true
);

SELECT set_config(
  'app.source_user_id',
  app.resolve_anonymous_identity(
    'device_sha256',
    current_setting('app.test_identity_hash')
  ) ->> 'userId',
  true
);

SELECT set_config(
  'app.identity_replay_result',
  app.resolve_anonymous_identity(
    'device_sha256',
    current_setting('app.test_identity_hash')
  )::text,
  true
);

SELECT set_config(
  'app.target_user_id',
  'acct:merge_test_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);

SELECT set_config(
  'app.other_target_user_id',
  'acct:merge_other_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);

INSERT INTO app.users (user_id)
VALUES
  (current_setting('app.target_user_id')),
  (current_setting('app.other_target_user_id'));

-- 正式档案超过30天；体重和场景与游客冲突，身高和限制为空缺。
INSERT INTO app.user_profiles (
  user_id,
  current_weight_kg,
  scene,
  taste_preferences,
  updated_at
)
VALUES (
  current_setting('app.target_user_id'),
  70,
  'takeaway',
  '["清淡"]'::jsonb,
  clock_timestamp() - interval '40 days'
);

-- 方案B确认请求链：拒绝无请求确认，保留被新提问取消的旧请求，
-- 验证展示范围、值一致、单次消费和同参数安全重试。
SELECT set_config('app.current_user_id', current_setting('app.source_user_id'), true);
SET LOCAL ROLE diet_app;

DO $test$
BEGIN
  PERFORM set_config('app.merge_from_anonymous_context_rejected', 'false', true);
  BEGIN
    PERFORM app.merge_current_account_from_anonymous(
      current_setting('app.source_user_id')
    );
  EXCEPTION WHEN SQLSTATE '28000' THEN
    PERFORM set_config('app.merge_from_anonymous_context_rejected', 'true', true);
  END;
END
$test$;

SELECT set_config(
  'app.confirm_profile',
  '{
    "schemaVersion": 1,
    "body": {
      "equationSex": null,
      "ageYears": null,
      "heightCm": 165,
      "currentWeightKg": 65,
      "targetWeightKg": null,
      "dailyActivity": null,
      "recentWeightChange": null
    },
    "diet": {
      "scene": "cafeteria",
      "cafeteriaMode": "unknown",
      "budgetCnyPerMeal": null,
      "tastePreferences": [],
      "restrictions": ["酸奶后腹泻"],
      "goals": [],
      "exerciseBaseline": null
    }
  }',
  true
);

DO $test$
BEGIN
  PERFORM set_config('app.confirm_without_pending_rejected', 'false', true);
  BEGIN
    PERFORM app.save_current_long_term_profile_fields(
      current_setting('app.confirm_profile')::jsonb,
      '["body.heightCm"]'::jsonb,
      public.gen_random_uuid(),
      'response-without-request',
      clock_timestamp()
    );
  EXCEPTION WHEN SQLSTATE '23514' THEN
    PERFORM set_config('app.confirm_without_pending_rejected', 'true', true);
  END;
END
$test$;

SELECT set_config('app.old_prompted_at', clock_timestamp()::text, true);
SELECT set_config(
  'app.old_confirmation_request',
  app.begin_current_long_term_profile_confirmation(
    'onboarding-merge-main',
    'prompt-main-old',
    '{"body.heightCm":164}'::jsonb,
    current_setting('app.old_prompted_at')::timestamptz
  )::text,
  true
);

SELECT set_config('app.main_prompted_at', clock_timestamp()::text, true);
SELECT set_config(
  'app.main_confirmation_request',
  app.begin_current_long_term_profile_confirmation(
    'onboarding-merge-main',
    'prompt-main-current',
    '{
      "body.heightCm":165,
      "body.currentWeightKg":65,
      "diet.scene":"cafeteria",
      "diet.restrictions":["酸奶后腹泻"]
    }'::jsonb,
    current_setting('app.main_prompted_at')::timestamptz
  )::text,
  true
);

SELECT set_config(
  'app.main_confirmation_request_id',
  current_setting('app.main_confirmation_request')::jsonb ->> 'requestId',
  true
);

SELECT set_config(
  'app.begin_replay_result',
  app.begin_current_long_term_profile_confirmation(
    'onboarding-merge-main',
    'prompt-main-current',
    '{
      "body.heightCm":165,
      "body.currentWeightKg":65,
      "diet.scene":"cafeteria",
      "diet.restrictions":["酸奶后腹泻"]
    }'::jsonb,
    current_setting('app.main_prompted_at')::timestamptz
  )::text,
  true
);

DO $test$
BEGIN
  PERFORM set_config('app.begin_reuse_mismatch_rejected', 'false', true);
  BEGIN
    PERFORM app.begin_current_long_term_profile_confirmation(
      'onboarding-merge-main',
      'prompt-main-current',
      '{"body.heightCm":166}'::jsonb,
      current_setting('app.main_prompted_at')::timestamptz
    );
  EXCEPTION WHEN SQLSTATE '23505' THEN
    PERFORM set_config('app.begin_reuse_mismatch_rejected', 'true', true);
  END;
END
$test$;

DO $test$
BEGIN
  PERFORM set_config('app.confirm_outside_presented_rejected', 'false', true);
  BEGIN
    PERFORM app.save_current_long_term_profile_fields(
      current_setting('app.confirm_profile')::jsonb,
      '["body.heightCm","body.ageYears"]'::jsonb,
      current_setting('app.main_confirmation_request_id')::uuid,
      'response-outside-presented',
      clock_timestamp()
    );
  EXCEPTION WHEN SQLSTATE '23514' THEN
    PERFORM set_config('app.confirm_outside_presented_rejected', 'true', true);
  END;
END
$test$;

DO $test$
BEGIN
  PERFORM set_config('app.confirm_value_mismatch_rejected', 'false', true);
  BEGIN
    PERFORM app.save_current_long_term_profile_fields(
      jsonb_set(
        current_setting('app.confirm_profile')::jsonb,
        '{body,heightCm}',
        '166'::jsonb
      ),
      '["body.heightCm","body.currentWeightKg","diet.scene","diet.restrictions"]'::jsonb,
      current_setting('app.main_confirmation_request_id')::uuid,
      'response-value-mismatch',
      clock_timestamp()
    );
  EXCEPTION WHEN SQLSTATE '23514' THEN
    PERFORM set_config('app.confirm_value_mismatch_rejected', 'true', true);
  END;
END
$test$;

SELECT set_config('app.main_responded_at', clock_timestamp()::text, true);
SELECT set_config(
  'app.confirm_save_result',
  app.save_current_long_term_profile_fields(
    current_setting('app.confirm_profile')::jsonb,
    '["body.heightCm","body.currentWeightKg","diet.scene","diet.restrictions"]'::jsonb,
    current_setting('app.main_confirmation_request_id')::uuid,
    'response-main-confirmed',
    current_setting('app.main_responded_at')::timestamptz
  )::text,
  true
);

SELECT set_config(
  'app.confirm_save_replay_result',
  app.save_current_long_term_profile_fields(
    current_setting('app.confirm_profile')::jsonb,
    '["body.heightCm","body.currentWeightKg","diet.scene","diet.restrictions"]'::jsonb,
    current_setting('app.main_confirmation_request_id')::uuid,
    'response-main-confirmed',
    current_setting('app.main_responded_at')::timestamptz
  )::text,
  true
);

DO $test$
BEGIN
  PERFORM set_config('app.confirm_second_consumption_rejected', 'false', true);
  BEGIN
    PERFORM app.save_current_long_term_profile_fields(
      current_setting('app.confirm_profile')::jsonb,
      '["body.heightCm","body.currentWeightKg","diet.scene","diet.restrictions"]'::jsonb,
      current_setting('app.main_confirmation_request_id')::uuid,
      'response-second-consumption',
      clock_timestamp()
    );
  EXCEPTION WHEN SQLSTATE '23505' THEN
    PERFORM set_config('app.confirm_second_consumption_rejected', 'true', true);
  END;
END
$test$;

-- 相同请求、相同回应只幂等返回；没有第二次档案修订或确认事实。
SELECT set_config(
  'app.confirm_replay_same_revision',
  (
    (
      current_setting('app.confirm_save_result')::jsonb ->> 'profileRevisionId'
    ) = (
      current_setting('app.confirm_save_replay_result')::jsonb ->> 'profileRevisionId'
    )
    AND (
      current_setting('app.confirm_save_replay_result')::jsonb ->> 'idempotentReplay'
    )::boolean
  )::text,
  true
);
RESET ROLE;

-- 即使受控所有者路径误操作，也不能直接伪造consumed、回退请求或改写事实。
DO $test$
BEGIN
  PERFORM set_config('app.direct_consumed_insert_rejected', 'false', true);
  PERFORM set_config('app.consumed_request_rewind_rejected', 'false', true);
  PERFORM set_config('app.confirmation_update_rejected', 'false', true);
  PERFORM set_config('app.confirmation_delete_rejected', 'false', true);

  BEGIN
    INSERT INTO app.long_term_profile_confirmation_requests (
      user_id, onboarding_session_id, prompt_turn_id, presented_fields,
      prompted_at, status, response_turn_id, responded_at, created_at, resolved_at
    )
    VALUES (
      current_setting('app.source_user_id'),
      'onboarding-forged',
      'prompt-forged',
      '{"body.heightCm":165}'::jsonb,
      clock_timestamp() - interval '1 second',
      'consumed',
      'response-forged',
      clock_timestamp(),
      clock_timestamp() - interval '1 second',
      clock_timestamp()
    );
  EXCEPTION WHEN SQLSTATE '23514' THEN
    PERFORM set_config('app.direct_consumed_insert_rejected', 'true', true);
  END;

  BEGIN
    UPDATE app.long_term_profile_confirmation_requests
    SET status = 'pending',
        response_turn_id = NULL,
        responded_at = NULL,
        resolved_at = NULL
    WHERE request_id = current_setting('app.main_confirmation_request_id')::uuid;
  EXCEPTION WHEN SQLSTATE '23514' THEN
    PERFORM set_config('app.consumed_request_rewind_rejected', 'true', true);
  END;

  BEGIN
    UPDATE app.long_term_profile_field_confirmations
    SET confirmed_value = '166'::jsonb
    WHERE confirmation_request_id = current_setting('app.main_confirmation_request_id')::uuid;
  EXCEPTION WHEN SQLSTATE '23514' THEN
    PERFORM set_config('app.confirmation_update_rejected', 'true', true);
  END;

  BEGIN
    DELETE FROM app.long_term_profile_field_confirmations
    WHERE confirmation_request_id = current_setting('app.main_confirmation_request_id')::uuid;
  EXCEPTION WHEN SQLSTATE '23514' THEN
    PERFORM set_config('app.confirmation_delete_rejected', 'true', true);
  END;
END
$test$;

-- 后续普通问答把当前快照中身高改成180，并顺带记录年龄29。
-- 两者都没有新的长期建档确认事实：合并仍应使用已确认身高165，年龄不参与。
UPDATE app.user_profiles
SET height_cm = 180,
    age_years = 29
WHERE user_id = current_setting('app.source_user_id');

SELECT set_config(
  'app.target_duplicate_event_id',
  'target_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.source_duplicate_event_id',
  'source_dup_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.source_exercise_event_id',
  'source_ex_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.source_sensitive_event_id',
  'source_sensitive_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.source_base_event_id',
  'source_base_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.source_correction_event_id',
  'source_correction_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.source_sensitive_correction_event_id',
  'source_sensitive_correction_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);

INSERT INTO app.user_events (
  event_id, user_id, event_type, occurred_at, recorded_at,
  payload, source, idempotency_key, status
)
VALUES
  (
    current_setting('app.target_duplicate_event_id'),
    current_setting('app.target_user_id'),
    'meal',
    '2026-08-18T12:00:00+08:00',
    '2026-08-18T12:01:00+08:00',
    '{"foods":["米饭"]}'::jsonb,
    'user',
    'merge-same-meal',
    'active'
  ),
  (
    current_setting('app.source_duplicate_event_id'),
    current_setting('app.source_user_id'),
    'meal',
    '2026-08-18T12:00:00+08:00',
    '2026-08-18T12:02:00+08:00',
    '{"foods":["米饭"]}'::jsonb,
    'user',
    'merge-same-meal',
    'active'
  ),
  (
    current_setting('app.source_exercise_event_id'),
    current_setting('app.source_user_id'),
    'exercise',
    '2026-08-18T18:00:00+08:00',
    '2026-08-18T18:01:00+08:00',
    '{"type":"跑步","durationMinutes":30}'::jsonb,
    'user',
    'merge-guest-run',
    'active'
  ),
  (
    current_setting('app.source_sensitive_event_id'),
    current_setting('app.source_user_id'),
    'menstrual_period_start',
    '2026-08-17T08:00:00+08:00',
    '2026-08-17T08:01:00+08:00',
    '{"rawText":"8月17日开始"}'::jsonb,
    'user',
    'merge-guest-sensitive',
    'active'
  ),
  (
    current_setting('app.source_base_event_id'),
    current_setting('app.source_user_id'),
    'check_in',
    '2026-08-18T20:00:00+08:00',
    '2026-08-18T20:01:00+08:00',
    '{"status":"original"}'::jsonb,
    'user',
    'merge-base',
    'active'
  );

INSERT INTO app.user_events (
  event_id, user_id, event_type, occurred_at, recorded_at,
  payload, source, idempotency_key, supersedes_event_id, status
)
VALUES (
  current_setting('app.source_correction_event_id'),
  current_setting('app.source_user_id'),
  'user_correction',
  '2026-08-18T20:05:00+08:00',
  '2026-08-18T20:06:00+08:00',
  '{"status":"corrected"}'::jsonb,
  'user',
  'merge-correction',
  current_setting('app.source_base_event_id'),
  'active'
);

-- 引用敏感事件的纠错也必须沿引用链保持受限，直到合并后重新授权。
INSERT INTO app.user_events (
  event_id, user_id, event_type, occurred_at, recorded_at,
  payload, source, idempotency_key, supersedes_event_id, status
)
VALUES (
  current_setting('app.source_sensitive_correction_event_id'),
  current_setting('app.source_user_id'),
  'user_correction',
  '2026-08-18T08:05:00+08:00',
  '2026-08-18T08:06:00+08:00',
  '{"note":"经期开始日期纠正"}'::jsonb,
  'user',
  'merge-sensitive-correction',
  current_setting('app.source_sensitive_event_id'),
  'active'
);

-- 合并前的旧授权，不得释放新迁入的敏感历史。
INSERT INTO app.user_consents (
  user_id, consent_type, status, recorded_at, source
)
VALUES (
  current_setting('app.target_user_id'),
  'menstrual_tracking',
  'granted',
  clock_timestamp() - interval '1 day',
  'user'
);

SELECT set_config(
  'app.current_user_id',
  current_setting('app.target_user_id'),
  true
);
SET LOCAL ROLE diet_app;

DO $test$
BEGIN
  PERFORM set_config('app.non_anonymous_source_rejected', 'false', true);
  BEGIN
    PERFORM app.merge_current_account_from_anonymous(
      current_setting('app.target_user_id')
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    PERFORM set_config('app.non_anonymous_source_rejected', 'true', true);
  END;
END
$test$;

SELECT set_config(
  'app.merge_result',
  app.merge_current_account_from_anonymous(
    current_setting('app.source_user_id')
  )::text,
  true
);
SELECT set_config(
  'app.merge_id',
  (current_setting('app.merge_result')::jsonb ->> 'mergeId'),
  true
);

SELECT set_config(
  'app.current_merge_query_result',
  app.get_current_user_merge(current_setting('app.source_user_id'))::text,
  true
);
SELECT set_config(
  'app.current_merge_review_result',
  app.get_current_merge_review(current_setting('app.merge_id')::uuid)::text,
  true
);

-- 旧授权释放必须被拒绝。
DO $test$
BEGIN
  PERFORM set_config('app.old_consent_release_rejected', 'false', true);
  BEGIN
    PERFORM app.release_current_merged_sensitive_events(
      current_setting('app.merge_id')::uuid
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.old_consent_release_rejected', 'true', true);
  END;
END
$test$;

SELECT set_config(
  'app.visible_sensitive_before_reconsent',
  (
    SELECT COUNT(*)::text
    FROM app.user_events
    WHERE event_type IN ('menstrual_period_start', 'menstrual_symptom')
  ),
  true
);

SELECT set_config(
  'app.visible_corrections_before_reconsent',
  (
    SELECT COUNT(*)::text
    FROM app.user_events
    WHERE event_type = 'user_correction'
  ),
  true
);

SELECT app.record_current_user_consent(
  jsonb_build_object(
    'consentType', 'menstrual_tracking',
    'status', 'granted',
    'recordedAt', clock_timestamp() + interval '1 second',
    'source', 'user'
  )
);

SELECT set_config(
  'app.released_sensitive_count',
  app.release_current_merged_sensitive_events(
    current_setting('app.merge_id')::uuid
  )::text,
  true
);

SELECT set_config(
  'app.visible_sensitive_after_reconsent',
  (
    SELECT COUNT(*)::text
    FROM app.user_events
    WHERE event_type IN ('menstrual_period_start', 'menstrual_symptom')
  ),
  true
);

SELECT set_config(
  'app.visible_corrections_after_reconsent',
  (
    SELECT COUNT(*)::text
    FROM app.user_events
    WHERE event_type = 'user_correction'
  ),
  true
);

SELECT set_config(
  'app.replayed_merge_result',
  app.merge_current_account_from_anonymous(
    current_setting('app.source_user_id')
  )::text,
  true
);
SELECT set_config(
  'app.replayed_merge_id',
  current_setting('app.replayed_merge_result')::jsonb ->> 'mergeId',
  true
);

SELECT set_config(
  'app.identity_after_merge_result',
  app.resolve_anonymous_identity(
    'device_sha256',
    current_setting('app.test_identity_hash')
  )::text,
  true
);

-- 同一游客不能被另一账号认领。
RESET ROLE;
SELECT set_config(
  'app.current_user_id',
  current_setting('app.other_target_user_id'),
  true
);
SET LOCAL ROLE diet_app;
SELECT set_config(
  'app.other_target_merge_query_hidden',
  (
    app.get_current_user_merge(current_setting('app.source_user_id')) IS NULL
    AND app.get_current_merge_review(current_setting('app.merge_id')::uuid) IS NULL
  )::text,
  true
);
DO $test$
BEGIN
  PERFORM set_config('app.other_target_rejected', 'false', true);
  BEGIN
    PERFORM app.merge_current_account_from_anonymous(
      current_setting('app.source_user_id')
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.other_target_rejected', 'true', true);
  END;
END
$test$;

-- 已合并的旧游客不能继续写入事件。
RESET ROLE;
SELECT set_config(
  'app.current_user_id',
  current_setting('app.source_user_id'),
  true
);
SET LOCAL ROLE diet_app;
SELECT set_config(
  'app.merged_source_visible_events',
  (SELECT COUNT(*)::text FROM app.user_events),
  true
);
SELECT set_config(
  'app.merged_source_visible_profiles',
  (SELECT COUNT(*)::text FROM app.user_profiles),
  true
);
DO $test$
BEGIN
  PERFORM set_config('app.merged_source_write_rejected', 'false', true);
  PERFORM set_config('app.merged_source_profile_rejected', 'false', true);
  PERFORM set_config('app.merged_source_consent_rejected', 'false', true);
  PERFORM set_config('app.merged_source_confirmation_rejected', 'false', true);

  BEGIN
    PERFORM app.append_current_user_event(
      jsonb_build_object(
        'eventType', 'meal',
        'occurredAt', clock_timestamp(),
        'payload', jsonb_build_object('attempt', 'after-merge'),
        'source', 'user',
        'idempotencyKey', 'merged-source-must-fail'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.merged_source_write_rejected', 'true', true);
  END;

  BEGIN
    PERFORM app.save_current_user_profile(
      current_setting('app.confirm_profile')::jsonb,
      'user'
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.merged_source_profile_rejected', 'true', true);
  END;

  BEGIN
    PERFORM app.record_current_user_consent(
      jsonb_build_object(
        'consentType', 'proactive_reminders',
        'status', 'granted',
        'recordedAt', clock_timestamp(),
        'source', 'user'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.merged_source_consent_rejected', 'true', true);
  END;

  BEGIN
    PERFORM app.begin_current_long_term_profile_confirmation(
      'onboarding-after-merge',
      'prompt-after-merge',
      '{"body.heightCm":165}'::jsonb,
      clock_timestamp()
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.merged_source_confirmation_rejected', 'true', true);
  END;
END
$test$;

-- 只有普通问答档案、没有长期建档字段确认：档案必须完全不参与合并。
RESET ROLE;
SELECT set_config(
  'app.noeligible_identity_hash',
  encode(public.digest(convert_to(public.gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'),
  true
);
SELECT set_config(
  'app.noeligible_source_user_id',
  app.resolve_anonymous_identity(
    'device_sha256',
    current_setting('app.noeligible_identity_hash')
  ) ->> 'userId',
  true
);
SELECT set_config(
  'app.noeligible_target_user_id',
  'acct:merge_noeligible_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
INSERT INTO app.users (user_id)
VALUES (current_setting('app.noeligible_target_user_id'));
INSERT INTO app.user_profiles (user_id, height_cm, current_weight_kg)
VALUES (current_setting('app.noeligible_source_user_id'), 171, 61);

SELECT set_config(
  'app.current_user_id',
  current_setting('app.noeligible_target_user_id'),
  true
);
SET LOCAL ROLE diet_app;
SELECT set_config(
  'app.noeligible_merge_id',
  app.merge_current_account_from_anonymous(
    current_setting('app.noeligible_source_user_id')
  ) ->> 'mergeId',
  true
);

-- 相同幂等键但事件时间或payload不同：不得静默去重，整次合并回滚。
RESET ROLE;
SELECT set_config(
  'app.collision_identity_hash',
  encode(public.digest(convert_to(public.gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'),
  true
);
SELECT set_config(
  'app.collision_source_user_id',
  app.resolve_anonymous_identity(
    'device_sha256',
    current_setting('app.collision_identity_hash')
  ) ->> 'userId',
  true
);
SELECT set_config(
  'app.collision_target_user_id',
  'acct:merge_collision_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
INSERT INTO app.users (user_id)
VALUES (current_setting('app.collision_target_user_id'));
INSERT INTO app.user_events (
  event_id, user_id, event_type, occurred_at, payload, source,
  idempotency_key, status
)
VALUES
  (
    'collision_target_' || replace(public.gen_random_uuid()::text, '-', ''),
    current_setting('app.collision_target_user_id'),
    'meal',
    '2026-08-18T12:00:00+08:00',
    '{"foods":["米饭"]}'::jsonb,
    'user',
    'merge-semantic-collision',
    'active'
  ),
  (
    'collision_source_' || replace(public.gen_random_uuid()::text, '-', ''),
    current_setting('app.collision_source_user_id'),
    'meal',
    '2026-08-18T12:05:00+08:00',
    '{"foods":["面条"]}'::jsonb,
    'user',
    'merge-semantic-collision',
    'active'
  );

SELECT set_config(
  'app.current_user_id',
  current_setting('app.collision_target_user_id'),
  true
);
SET LOCAL ROLE diet_app;
DO $test$
BEGIN
  PERFORM set_config('app.semantic_collision_rejected', 'false', true);
  BEGIN
    PERFORM app.merge_current_account_from_anonymous(
      current_setting('app.collision_source_user_id')
    );
  EXCEPTION WHEN SQLSTATE '23505' THEN
    PERFORM set_config('app.semantic_collision_rejected', 'true', true);
  END;
END
$test$;

-- 纠错事件复用目标账号幂等键但指向不同原记录：整体拒绝并回滚。
RESET ROLE;
SELECT set_config(
  'app.correction_collision_hash',
  encode(public.digest(convert_to(public.gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'),
  true
);
SELECT set_config(
  'app.correction_collision_source_user_id',
  app.resolve_anonymous_identity(
    'device_sha256',
    current_setting('app.correction_collision_hash')
  ) ->> 'userId',
  true
);
SELECT set_config(
  'app.correction_collision_target_user_id',
  'acct:merge_correction_collision_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.correction_target_base_a',
  'corr_target_a_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.correction_target_base_b',
  'corr_target_b_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
SELECT set_config(
  'app.correction_source_base_a',
  'corr_source_a_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
INSERT INTO app.users (user_id)
VALUES (current_setting('app.correction_collision_target_user_id'));
INSERT INTO app.user_events (
  event_id, user_id, event_type, occurred_at, payload, source,
  idempotency_key, status
)
VALUES
  (
    current_setting('app.correction_target_base_a'),
    current_setting('app.correction_collision_target_user_id'),
    'check_in',
    '2026-08-18T09:00:00+08:00',
    '{"status":"base-a"}'::jsonb,
    'user',
    'correction-base-a-shared',
    'active'
  ),
  (
    current_setting('app.correction_target_base_b'),
    current_setting('app.correction_collision_target_user_id'),
    'check_in',
    '2026-08-18T09:10:00+08:00',
    '{"status":"base-b"}'::jsonb,
    'user',
    'correction-base-b-target',
    'active'
  ),
  (
    current_setting('app.correction_source_base_a'),
    current_setting('app.correction_collision_source_user_id'),
    'check_in',
    '2026-08-18T09:00:00+08:00',
    '{"status":"base-a"}'::jsonb,
    'user',
    'correction-base-a-shared',
    'active'
  );
INSERT INTO app.user_events (
  event_id, user_id, event_type, occurred_at, payload, source,
  idempotency_key, supersedes_event_id, status
)
VALUES
  (
    'corr_target_' || replace(public.gen_random_uuid()::text, '-', ''),
    current_setting('app.correction_collision_target_user_id'),
    'user_correction',
    '2026-08-18T09:20:00+08:00',
    '{"status":"corrected"}'::jsonb,
    'user',
    'correction-semantic-collision',
    current_setting('app.correction_target_base_b'),
    'active'
  ),
  (
    'corr_source_' || replace(public.gen_random_uuid()::text, '-', ''),
    current_setting('app.correction_collision_source_user_id'),
    'user_correction',
    '2026-08-18T09:20:00+08:00',
    '{"status":"corrected"}'::jsonb,
    'user',
    'correction-semantic-collision',
    current_setting('app.correction_source_base_a'),
    'active'
  );

SELECT set_config(
  'app.current_user_id',
  current_setting('app.correction_collision_target_user_id'),
  true
);
SET LOCAL ROLE diet_app;
DO $test$
BEGIN
  PERFORM set_config('app.correction_collision_rejected', 'false', true);
  BEGIN
    PERFORM app.merge_current_account_from_anonymous(
      current_setting('app.correction_collision_source_user_id')
    );
  EXCEPTION WHEN SQLSTATE '23505' THEN
    PERFORM set_config('app.correction_collision_rejected', 'true', true);
  END;
END
$test$;

-- 后段故障注入：身份改绑时强制失败，检查前面的合并、事件副本也全部回滚。
RESET ROLE;
SELECT set_config(
  'app.failure_identity_hash',
  encode(public.digest(convert_to(public.gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'),
  true
);
SELECT set_config(
  'app.failure_source_user_id',
  app.resolve_anonymous_identity(
    'device_sha256',
    current_setting('app.failure_identity_hash')
  ) ->> 'userId',
  true
);
SELECT set_config(
  'app.failure_target_user_id',
  'acct:merge_failure_' || replace(public.gen_random_uuid()::text, '-', ''),
  true
);
INSERT INTO app.users (user_id)
VALUES (current_setting('app.failure_target_user_id'));
INSERT INTO app.user_events (
  event_id, user_id, event_type, occurred_at, payload, source,
  idempotency_key, status
)
VALUES (
  'failure_source_' || replace(public.gen_random_uuid()::text, '-', ''),
  current_setting('app.failure_source_user_id'),
  'exercise',
  clock_timestamp(),
  '{"type":"walk"}'::jsonb,
  'user',
  'failure-source-event',
  'active'
);

CREATE OR REPLACE FUNCTION pg_temp.fail_test_identity_rebind()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.user_id = current_setting('app.failure_source_user_id') THEN
    RAISE EXCEPTION 'injected identity rebind failure'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER identity_merge_failure_injection
BEFORE UPDATE ON app.user_identities
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_test_identity_rebind();

SELECT set_config(
  'app.current_user_id',
  current_setting('app.failure_target_user_id'),
  true
);
SET LOCAL ROLE diet_app;
DO $test$
BEGIN
  PERFORM set_config('app.failure_injection_caught', 'false', true);
  BEGIN
    PERFORM app.merge_current_account_from_anonymous(
      current_setting('app.failure_source_user_id')
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.failure_injection_caught', 'true', true);
  END;
END
$test$;

RESET ROLE;

-- 最终自动核验。
SELECT
  CASE
    WHEN
      -- 方案B：旧请求留痕、展示范围受限、一次消费且同参数可安全重试
      current_setting('app.confirm_without_pending_rejected') = 'true'
      AND current_setting('app.begin_reuse_mismatch_rejected') = 'true'
      AND current_setting('app.confirm_outside_presented_rejected') = 'true'
      AND current_setting('app.confirm_value_mismatch_rejected') = 'true'
      AND current_setting('app.confirm_second_consumption_rejected') = 'true'
      AND current_setting('app.confirm_replay_same_revision') = 'true'
      AND current_setting('app.direct_consumed_insert_rejected') = 'true'
      AND current_setting('app.consumed_request_rewind_rejected') = 'true'
      AND current_setting('app.confirmation_update_rejected') = 'true'
      AND current_setting('app.confirmation_delete_rejected') = 'true'
      AND (
        current_setting('app.begin_replay_result')::jsonb ->> 'requestId'
      ) = current_setting('app.main_confirmation_request_id')
      AND (
        current_setting('app.begin_replay_result')::jsonb ->> 'idempotentReplay'
      )::boolean
      AND EXISTS (
        SELECT 1
        FROM app.long_term_profile_confirmation_requests AS old_request
        JOIN app.long_term_profile_confirmation_requests AS new_request
          ON new_request.user_id = old_request.user_id
         AND new_request.onboarding_session_id = old_request.onboarding_session_id
         AND new_request.created_at = old_request.resolved_at
        WHERE old_request.request_id = (
                current_setting('app.old_confirmation_request')::jsonb ->> 'requestId'
              )::uuid
          AND old_request.status = 'cancelled'
          AND new_request.request_id = current_setting('app.main_confirmation_request_id')::uuid
          AND new_request.status = 'consumed'
          AND new_request.response_turn_id = 'response-main-confirmed'
          AND new_request.responded_at = current_setting('app.main_responded_at')::timestamptz
      )
      AND (
        SELECT COUNT(*)
        FROM app.long_term_profile_field_confirmations AS confirmation
        WHERE confirmation.confirmation_request_id =
              current_setting('app.main_confirmation_request_id')::uuid
      ) = 4
      AND (
        SELECT COUNT(DISTINCT confirmation.profile_revision_id)
        FROM app.long_term_profile_field_confirmations AS confirmation
        WHERE confirmation.confirmation_request_id =
              current_setting('app.main_confirmation_request_id')::uuid
      ) = 1
      AND (
        SELECT COUNT(*)
        FROM app.profile_revisions AS revision
        WHERE revision.user_id = current_setting('app.source_user_id')
          AND revision.source = 'secretary'
      ) = 1

      -- 档案：账号优先 + 游客填空缺
      AND EXISTS (
        SELECT 1
        FROM app.user_profiles AS up
        WHERE up.user_id = current_setting('app.target_user_id')
          AND up.current_weight_kg = 70
          AND up.height_cm = 165
          AND up.age_years IS NULL
          AND up.scene = 'takeaway'
          AND up.restrictions = '["酸奶后腹泻"]'::jsonb
      )
      AND (
        SELECT COUNT(*)
        FROM app.profile_merge_conflicts
        WHERE merge_id = current_setting('app.merge_id')::uuid
          AND resolution_status = 'pending'
          AND account_stale_over_30_days
      ) = 2

      -- 事件：一条去重；敏感事件及其纠错链均受限迁移
      AND (
        SELECT COUNT(*)
        FROM app.event_merge_audit
        WHERE merge_id = current_setting('app.merge_id')::uuid
      ) = 6
      AND (
        SELECT COUNT(*)
        FROM app.event_merge_audit
        WHERE merge_id = current_setting('app.merge_id')::uuid
          AND action = 'deduplicated'
      ) = 1
      AND (
        SELECT COUNT(*)
        FROM app.event_merge_audit
        WHERE merge_id = current_setting('app.merge_id')::uuid
          AND action = 'migrated_restricted'
      ) = 2

      -- 纠错副本引用目标侧原事件副本
      AND EXISTS (
        SELECT 1
        FROM app.event_merge_audit AS correction_audit
        JOIN app.user_events AS correction
          ON correction.event_id = correction_audit.target_event_id
        JOIN app.event_merge_audit AS base_audit
          ON base_audit.merge_id = correction_audit.merge_id
         AND base_audit.source_event_id = current_setting('app.source_base_event_id')
        WHERE correction_audit.merge_id = current_setting('app.merge_id')::uuid
          AND correction_audit.source_event_id = current_setting('app.source_correction_event_id')
          AND correction.supersedes_event_id = base_audit.target_event_id
          AND correction.user_id = current_setting('app.target_user_id')
      )

      -- 源事件全部保留，身份改绑并锁定
      AND (
        SELECT COUNT(*) FROM app.user_events
        WHERE user_id = current_setting('app.source_user_id')
      ) = 6
      AND EXISTS (
        SELECT 1 FROM app.users
        WHERE user_id = current_setting('app.source_user_id')
          AND status = 'merged'
          AND merged_into_user_id = current_setting('app.target_user_id')
      )
      AND EXISTS (
        SELECT 1 FROM app.user_identities
        WHERE external_subject_hash = current_setting('app.test_identity_hash')
          AND user_id = current_setting('app.target_user_id')
      )

      -- 敏感历史必须合并后重新授权
      AND current_setting('app.old_consent_release_rejected') = 'true'
      AND current_setting('app.visible_sensitive_before_reconsent') = '0'
      AND current_setting('app.visible_corrections_before_reconsent') = '1'
      AND current_setting('app.released_sensitive_count') = '2'
      AND current_setting('app.visible_sensitive_after_reconsent') = '1'
      AND current_setting('app.visible_corrections_after_reconsent') = '2'

      -- 幂等、跨账号拒绝和源身份锁定
      AND current_setting('app.merge_from_anonymous_context_rejected') = 'true'
      AND current_setting('app.non_anonymous_source_rejected') = 'true'
      AND (
        current_setting('app.identity_replay_result')::jsonb ->> 'userId'
      ) = current_setting('app.source_user_id')
      AND (
        current_setting('app.identity_replay_result')::jsonb ->> 'existing'
      )::boolean
      AND (
        current_setting('app.identity_after_merge_result')::jsonb ->> 'userId'
      ) = current_setting('app.target_user_id')
      AND (
        current_setting('app.current_merge_query_result')::jsonb ->> 'mergeId'
      ) = current_setting('app.merge_id')
      AND (
        current_setting('app.current_merge_review_result')::jsonb ->> 'pendingConflictCount'
      )::integer = 2
      AND jsonb_array_length(
        current_setting('app.current_merge_review_result')::jsonb -> 'eventAudit'
      ) = 6
      AND current_setting('app.other_target_merge_query_hidden') = 'true'
      AND current_setting('app.replayed_merge_id') = current_setting('app.merge_id')
      AND (
        current_setting('app.replayed_merge_result')::jsonb ->> 'idempotentReplay'
      )::boolean
      AND (
        current_setting('app.replayed_merge_result')::jsonb ->> 'profileConflictCount'
      ) = (
        current_setting('app.merge_result')::jsonb ->> 'profileConflictCount'
      )
      AND (
        current_setting('app.replayed_merge_result')::jsonb ->> 'migratedEventCount'
      ) = (
        current_setting('app.merge_result')::jsonb ->> 'migratedEventCount'
      )
      AND (
        current_setting('app.replayed_merge_result')::jsonb ->> 'deduplicatedEventCount'
      ) = (
        current_setting('app.merge_result')::jsonb ->> 'deduplicatedEventCount'
      )
      AND current_setting('app.other_target_rejected') = 'true'
      AND current_setting('app.merged_source_visible_events') = '0'
      AND current_setting('app.merged_source_visible_profiles') = '0'
      AND current_setting('app.merged_source_write_rejected') = 'true'
      AND current_setting('app.merged_source_profile_rejected') = 'true'
      AND current_setting('app.merged_source_consent_rejected') = 'true'
      AND current_setting('app.merged_source_confirmation_rejected') = 'true'

      -- 从未进入长期建档的游客普通档案不填补、不生成冲突
      AND NOT EXISTS (
        SELECT 1 FROM app.user_profiles
        WHERE user_id = current_setting('app.noeligible_target_user_id')
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.profile_merge_conflicts
        WHERE merge_id = current_setting('app.noeligible_merge_id')::uuid
      )

      -- 幂等键相同但完整语义不同必须拒绝，且不留下半合并
      AND current_setting('app.semantic_collision_rejected') = 'true'
      AND NOT EXISTS (
        SELECT 1 FROM app.user_merges
        WHERE source_user_id = current_setting('app.collision_source_user_id')
      )
      AND EXISTS (
        SELECT 1 FROM app.users
        WHERE user_id = current_setting('app.collision_source_user_id')
          AND status = 'active'
          AND merged_into_user_id IS NULL
      )
      AND (
        SELECT COUNT(*) FROM app.user_events
        WHERE user_id = current_setting('app.collision_target_user_id')
          AND idempotency_key = 'merge-semantic-collision'
      ) = 1

      -- 纠错幂等键指向不同目标原记录时也必须整体拒绝
      AND current_setting('app.correction_collision_rejected') = 'true'
      AND NOT EXISTS (
        SELECT 1 FROM app.user_merges
        WHERE source_user_id = current_setting('app.correction_collision_source_user_id')
      )
      AND EXISTS (
        SELECT 1 FROM app.users
        WHERE user_id = current_setting('app.correction_collision_source_user_id')
          AND status = 'active'
          AND merged_into_user_id IS NULL
      )
      AND (
        SELECT COUNT(*) FROM app.user_events
        WHERE user_id = current_setting('app.correction_collision_target_user_id')
          AND idempotency_key = 'correction-semantic-collision'
      ) = 1

      -- 后段故障必须整体回滚
      AND current_setting('app.failure_injection_caught') = 'true'
      AND NOT EXISTS (
        SELECT 1 FROM app.user_merges
        WHERE source_user_id = current_setting('app.failure_source_user_id')
      )
      AND EXISTS (
        SELECT 1 FROM app.users
        WHERE user_id = current_setting('app.failure_source_user_id')
          AND status = 'active'
          AND merged_into_user_id IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM app.user_identities
        WHERE external_subject_hash = current_setting('app.failure_identity_hash')
          AND user_id = current_setting('app.failure_source_user_id')
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.user_events
        WHERE user_id = current_setting('app.failure_target_user_id')
          AND idempotency_key = 'failure-source-event'
      )
    THEN 'PASS'
    ELSE 'FAIL'
  END AS identity_merge_full_result,
  current_setting('app.merge_id') AS merge_id,
  current_setting('app.confirm_without_pending_rejected') AS confirm_without_pending_rejected,
  current_setting('app.begin_reuse_mismatch_rejected') AS begin_reuse_mismatch_rejected,
  current_setting('app.confirm_outside_presented_rejected') AS confirm_outside_presented_rejected,
  current_setting('app.confirm_value_mismatch_rejected') AS confirm_value_mismatch_rejected,
  current_setting('app.confirm_second_consumption_rejected') AS confirm_second_consumption_rejected,
  current_setting('app.confirm_replay_same_revision') AS confirm_replay_same_revision,
  current_setting('app.direct_consumed_insert_rejected') AS direct_consumed_insert_rejected,
  current_setting('app.consumed_request_rewind_rejected') AS consumed_request_rewind_rejected,
  current_setting('app.confirmation_update_rejected') AS confirmation_update_rejected,
  current_setting('app.confirmation_delete_rejected') AS confirmation_delete_rejected,
  current_setting('app.merge_from_anonymous_context_rejected') AS anonymous_context_rejected,
  current_setting('app.non_anonymous_source_rejected') AS non_anonymous_source_rejected,
  current_setting('app.old_consent_release_rejected') AS old_consent_rejected,
  current_setting('app.released_sensitive_count') AS released_sensitive_count,
  current_setting('app.visible_corrections_before_reconsent') AS corrections_before_reconsent,
  current_setting('app.visible_corrections_after_reconsent') AS corrections_after_reconsent,
  current_setting('app.other_target_merge_query_hidden') AS other_target_merge_query_hidden,
  current_setting('app.other_target_rejected') AS other_target_rejected,
  current_setting('app.merged_source_visible_events') AS merged_source_visible_events,
  current_setting('app.merged_source_visible_profiles') AS merged_source_visible_profiles,
  current_setting('app.merged_source_write_rejected') AS merged_source_write_rejected,
  current_setting('app.merged_source_profile_rejected') AS merged_source_profile_rejected,
  current_setting('app.merged_source_consent_rejected') AS merged_source_consent_rejected,
  current_setting('app.merged_source_confirmation_rejected') AS merged_source_confirmation_rejected,
  current_setting('app.semantic_collision_rejected') AS semantic_collision_rejected,
  current_setting('app.correction_collision_rejected') AS correction_collision_rejected,
  current_setting('app.failure_injection_caught') AS failure_injection_caught;

ROLLBACK;

-- 预期：identity_merge_full_result = PASS。
-- 本脚本通过后仍要保留 DMC 的完整输出，不只记录最后一个 PASS。

-- C. FOR KEY SHARE 并发边界必须使用两个独立DMC会话验证，不能伪装成上面的单会话PASS。
-- 会话A：以active游客开启事务并写入一条事件，保持事务未提交；写入触发器持有users行KEY SHARE锁。
-- 会话B：同时发起该游客到账号的合并，预期等待而不是越过会话A。
-- 会话A提交后：会话B继续并成功，且新事件必须出现在event_merge_audit和目标账号副本中。
-- 反向用例：会话B先完成合并；会话A随后尝试游客档案、授权、事件或确认请求写入，均必须被拒绝。
-- 两个会话的原始输出和阻塞/提交顺序必须随最终云端验收记录保存。
