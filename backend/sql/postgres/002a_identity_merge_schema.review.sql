-- REVIEW ONLY: 002 身份合并批次的表结构。
-- 未完成 002a-002d 全部静态审核和真实测试前，不得在腾讯云执行。

BEGIN;
SET LOCAL ROLE diet_owner;

-- 001历史稿对授权入库时间列存在差异。002的“合并后重新授权”必须同时
-- 校验业务 recorded_at 和数据库 created_at，因此这里显式收敛基线形态。
DO $migration$
DECLARE
  v_data_type text;
  v_is_nullable text;
  v_column_default text;
BEGIN
  SELECT column_info.data_type, column_info.is_nullable, column_info.column_default
  INTO v_data_type, v_is_nullable, v_column_default
  FROM information_schema.columns AS column_info
  WHERE column_info.table_schema = 'app'
    AND column_info.table_name = 'user_consents'
    AND column_info.column_name = 'created_at';

  IF NOT FOUND THEN
    EXECUTE '
      ALTER TABLE app.user_consents
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    ';
  ELSIF v_data_type IS DISTINCT FROM 'timestamp with time zone'
        OR v_is_nullable IS DISTINCT FROM 'NO'
        OR v_column_default IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'app.user_consents.created_at已存在但类型、非空或数据库默认值不符合002前置要求';
  END IF;
END
$migration$;

CREATE INDEX user_consents_user_created_idx
  ON app.user_consents (user_id, consent_type, created_at DESC, consent_id DESC);

CREATE TABLE app.user_identities (
  identity_type varchar(32) NOT NULL,
  external_subject_hash char(64) NOT NULL,
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_identities_pk
    PRIMARY KEY (identity_type, external_subject_hash),
  CONSTRAINT user_identities_type_chk
    CHECK (identity_type IN ('device_sha256')),
  CONSTRAINT user_identities_hash_chk
    CHECK (external_subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_identities_time_chk
    CHECK (last_seen_at >= created_at)
);

CREATE INDEX user_identities_user_idx
  ON app.user_identities (user_id);

CREATE TABLE app.user_merges (
  merge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_user_id varchar(128) NOT NULL UNIQUE
    REFERENCES app.users(user_id),
  target_user_id varchar(128) NOT NULL
    REFERENCES app.users(user_id),
  status varchar(20) NOT NULL DEFAULT 'completed',
  merged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_merges_source_chk
    CHECK (source_user_id LIKE 'anon:%'),
  CONSTRAINT user_merges_target_chk
    CHECK (target_user_id LIKE 'acct:%'),
  CONSTRAINT user_merges_distinct_users_chk
    CHECK (source_user_id <> target_user_id),
  CONSTRAINT user_merges_status_chk
    CHECK (status = 'completed')
);

CREATE INDEX user_merges_target_time_idx
  ON app.user_merges (target_user_id, merged_at DESC, merge_id DESC);

ALTER TABLE app.profile_revisions
  ADD CONSTRAINT profile_revisions_user_revision_unique
  UNIQUE (user_id, revision_id);

CREATE TABLE app.long_term_profile_confirmation_requests (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id),
  onboarding_session_id varchar(128) NOT NULL,
  prompt_turn_id varchar(128) NOT NULL,
  presented_fields jsonb NOT NULL,
  prompted_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  response_turn_id varchar(128),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CONSTRAINT long_term_profile_requests_session_chk
    CHECK (onboarding_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT long_term_profile_requests_prompt_turn_chk
    CHECK (prompt_turn_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT long_term_profile_requests_response_turn_chk
    CHECK (
      response_turn_id IS NULL
      OR response_turn_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  CONSTRAINT long_term_profile_requests_presented_chk
    CHECK (
      jsonb_typeof(presented_fields) = 'object'
      AND presented_fields <> '{}'::jsonb
    ),
  CONSTRAINT long_term_profile_requests_status_chk
    CHECK (status IN ('pending', 'consumed', 'cancelled')),
  CONSTRAINT long_term_profile_requests_lifecycle_chk
    CHECK (
      (
        status = 'pending'
        AND response_turn_id IS NULL
        AND responded_at IS NULL
        AND resolved_at IS NULL
      )
      OR (
        status = 'consumed'
        AND response_turn_id IS NOT NULL
        AND response_turn_id <> prompt_turn_id
        AND responded_at IS NOT NULL
        AND responded_at >= prompted_at
        AND resolved_at IS NOT NULL
        AND resolved_at >= created_at
      )
      OR (
        status = 'cancelled'
        AND response_turn_id IS NULL
        AND responded_at IS NULL
        AND resolved_at IS NOT NULL
        AND resolved_at >= created_at
      )
    ),
  CONSTRAINT long_term_profile_requests_user_request_unique
    UNIQUE (user_id, request_id),
  CONSTRAINT long_term_profile_requests_prompt_unique
    UNIQUE (user_id, prompt_turn_id),
  CONSTRAINT long_term_profile_requests_response_unique
    UNIQUE (user_id, response_turn_id)
);

CREATE UNIQUE INDEX long_term_profile_requests_one_pending_idx
  ON app.long_term_profile_confirmation_requests (
    user_id, onboarding_session_id
  )
  WHERE status = 'pending';

CREATE INDEX long_term_profile_requests_user_time_idx
  ON app.long_term_profile_confirmation_requests (
    user_id, created_at DESC, request_id DESC
  );

CREATE TABLE app.long_term_profile_field_confirmations (
  confirmation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(128) NOT NULL,
  field_path varchar(100) NOT NULL,
  confirmed_value jsonb NOT NULL,
  profile_revision_id uuid NOT NULL,
  confirmation_request_id uuid NOT NULL,
  onboarding_session_id varchar(128) NOT NULL,
  confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT long_term_profile_confirmations_field_chk
    CHECK (field_path IN (
      'body.equationSex', 'body.ageYears', 'body.heightCm',
      'body.currentWeightKg', 'body.targetWeightKg',
      'body.dailyActivity', 'body.recentWeightChange',
      'diet.scene', 'diet.cafeteriaMode', 'diet.budgetCnyPerMeal',
      'diet.tastePreferences', 'diet.restrictions', 'diet.goals',
      'diet.exerciseBaseline'
    )),
  CONSTRAINT long_term_profile_confirmations_value_chk
    CHECK (confirmed_value <> 'null'::jsonb),
  CONSTRAINT long_term_profile_confirmations_session_chk
    CHECK (onboarding_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT long_term_profile_confirmations_revision_fk
    FOREIGN KEY (user_id, profile_revision_id)
    REFERENCES app.profile_revisions(user_id, revision_id)
    ON DELETE CASCADE,
  CONSTRAINT long_term_profile_confirmations_request_fk
    FOREIGN KEY (user_id, confirmation_request_id)
    REFERENCES app.long_term_profile_confirmation_requests(user_id, request_id),
  CONSTRAINT long_term_profile_confirmations_unique
    UNIQUE (user_id, field_path, profile_revision_id),
  CONSTRAINT long_term_profile_confirmations_request_field_unique
    UNIQUE (confirmation_request_id, field_path)
);

CREATE INDEX long_term_profile_confirmations_latest_idx
  ON app.long_term_profile_field_confirmations (
    user_id, field_path, created_at DESC, confirmation_id DESC
  );

CREATE TABLE app.profile_merge_conflicts (
  conflict_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merge_id uuid NOT NULL
    REFERENCES app.user_merges(merge_id) ON DELETE CASCADE,
  field_path varchar(100) NOT NULL,
  account_value jsonb NOT NULL,
  guest_value jsonb NOT NULL,
  account_updated_at timestamptz,
  guest_updated_at timestamptz,
  account_stale_over_30_days boolean NOT NULL DEFAULT false,
  resolution_status varchar(20) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profile_merge_conflicts_path_chk
    CHECK (field_path ~ '^(body|diet)\.[A-Za-z][A-Za-z0-9]*$'),
  CONSTRAINT profile_merge_conflicts_resolution_chk
    CHECK (resolution_status IN ('pending', 'account_kept', 'guest_accepted')),
  CONSTRAINT profile_merge_conflicts_unique
    UNIQUE (merge_id, field_path)
);

CREATE INDEX profile_merge_conflicts_pending_idx
  ON app.profile_merge_conflicts (created_at, merge_id)
  WHERE resolution_status = 'pending';

CREATE TABLE app.event_merge_audit (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merge_id uuid NOT NULL
    REFERENCES app.user_merges(merge_id) ON DELETE CASCADE,
  source_event_id varchar(128) NOT NULL
    REFERENCES app.user_events(event_id),
  target_event_id varchar(128) NOT NULL
    REFERENCES app.user_events(event_id),
  action varchar(32) NOT NULL,
  event_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT event_merge_audit_action_chk
    CHECK (action IN ('migrated', 'deduplicated', 'migrated_restricted')),
  CONSTRAINT event_merge_audit_hash_chk
    CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_merge_audit_source_unique
    UNIQUE (merge_id, source_event_id)
);

CREATE INDEX event_merge_audit_target_idx
  ON app.event_merge_audit (merge_id, target_event_id);

ALTER TABLE app.user_events
  ADD COLUMN status varchar(32) NOT NULL DEFAULT 'active';

ALTER TABLE app.user_events
  ADD CONSTRAINT user_events_status_chk
  CHECK (status IN ('active', 'restricted_pending_consent'));

CREATE INDEX user_events_user_status_occurred_idx
  ON app.user_events (user_id, status, occurred_at DESC, event_id DESC);

COMMIT;

-- 除 user_consents.created_at 的已知001版本差异使用“缺失则补、存在则严查”外，
-- 本脚本故意不使用 IF NOT EXISTS：重复执行或未知基线偏差必须 fail closed。
