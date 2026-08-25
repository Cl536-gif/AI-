-- 004k 云端功能沙箱。所有业务写入均在同一事务中并最终ROLLBACK。
-- 固定测试ID仅用于零残留证明，不读取或输出真实用户数据。
BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004k_verify_a', 'acct:004k_verify_b')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004k固定沙箱用户已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004k_verify_a', true);
SET LOCAL ROLE diet_app;

DO $assert_idempotent_record$
DECLARE
  v_first jsonb;
  v_repeated jsonb;
BEGIN
  v_first := app.record_current_user_advice(
    '{
      "adviceType":"initial_meal_plan",
      "serviceMode":"free",
      "content":"004k沙箱建议A-原始内容",
      "metadata":{"source":"sandbox","version":1},
      "threadId":"thread-004k-a",
      "idempotencyKey":"004k-shared-key"
    }'::jsonb,
    '2026-08-25T08:00:00Z'::timestamptz
  );
  v_repeated := app.record_current_user_advice(
    '{
      "adviceType":"ad_hoc_meal_advice",
      "serviceMode":"long_term_onboarding",
      "content":"004k沙箱建议A-重试内容不应覆盖",
      "metadata":{"source":"retry"},
      "threadId":"thread-004k-retry",
      "idempotencyKey":"004k-shared-key"
    }'::jsonb,
    '2026-08-25T08:30:00Z'::timestamptz
  );

  IF v_first->>'adviceId' IS NULL
     OR v_repeated->>'adviceId' <> v_first->>'adviceId'
     OR v_repeated->>'content' <> '004k沙箱建议A-原始内容'
     OR v_repeated->>'createdAt' <> v_first->>'createdAt' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004k建议幂等写入断言失败';
  END IF;
END
$assert_idempotent_record$;

SELECT 'PASS' AS advice_recorded_idempotently;

SELECT app.record_current_user_advice(
  '{
    "adviceType":"ad_hoc_meal_advice",
    "serviceMode":"free",
    "content":"004k沙箱建议A-第二条",
    "metadata":{"source":"sandbox","version":2},
    "threadId":"thread-004k-a",
    "idempotencyKey":"004k-second-key"
  }'::jsonb,
  '2026-08-25T09:00:00Z'::timestamptz
) AS second_advice_result;

DO $assert_history_order_and_snapshot$
DECLARE
  v_count integer;
  v_latest_content text;
  v_latest_version integer;
  v_latest_thread varchar;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM app.user_advice_history
  WHERE user_id = 'acct:004k_verify_a';

  SELECT content, (metadata->>'version')::integer, thread_id
  INTO v_latest_content, v_latest_version, v_latest_thread
  FROM app.user_advice_history
  WHERE user_id = 'acct:004k_verify_a'
  ORDER BY created_at DESC, advice_id DESC
  LIMIT 1;

  IF v_count <> 2
     OR v_latest_content <> '004k沙箱建议A-第二条'
     OR v_latest_version <> 2
     OR v_latest_thread <> 'thread-004k-a' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004k建议历史排序或快照断言失败';
  END IF;
END
$assert_history_order_and_snapshot$;

SELECT 'PASS' AS advice_history_order_and_snapshot_verified;

DO $assert_invalid_payloads$
DECLARE
  v_count integer;
BEGIN
  BEGIN
    PERFORM app.record_current_user_advice(
      '{"content":"x","idempotencyKey":"bad-unknown","unexpected":true}'::jsonb,
      clock_timestamp()
    );
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004k未知字段未被拒绝';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM app.record_current_user_advice(
      '{"content":"x","metadata":[],"idempotencyKey":"bad-metadata"}'::jsonb,
      clock_timestamp()
    );
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004k错误元数据类型未被拒绝';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  SELECT COUNT(*) INTO v_count
  FROM app.user_advice_history
  WHERE user_id = 'acct:004k_verify_a';

  IF v_count <> 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004k非法输入新增了建议记录';
  END IF;
END
$assert_invalid_payloads$;

SELECT 'PASS' AS invalid_advice_rejected_without_mutation;

RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004k_verify_b', true);
SET LOCAL ROLE diet_app;

DO $assert_cross_user_isolation$
DECLARE
  v_user_b jsonb;
BEGIN
  IF (SELECT COUNT(*) FROM app.user_advice_history
      WHERE user_id = 'acct:004k_verify_a') <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004k跨用户建议读取隔离失败';
  END IF;

  v_user_b := app.record_current_user_advice(
    '{
      "content":"004k沙箱建议B",
      "idempotencyKey":"004k-shared-key"
    }'::jsonb,
    '2026-08-25T10:00:00Z'::timestamptz
  );

  IF v_user_b->>'userId' <> 'acct:004k_verify_b'
     OR v_user_b->>'adviceType' <> 'meal_advice'
     OR v_user_b->>'serviceMode' <> 'free' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004k跨用户幂等键或默认值断言失败';
  END IF;
END
$assert_cross_user_isolation$;

SELECT 'PASS' AS cross_user_isolation_and_defaults_verified;

RESET ROLE;
ROLLBACK;

SELECT
  CASE
    WHEN remaining_users = 0 AND remaining_advice = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS cleanup_status,
  cleanup.*
FROM (
  SELECT
    (SELECT COUNT(*) FROM app.users
     WHERE user_id IN ('acct:004k_verify_a', 'acct:004k_verify_b')) AS remaining_users,
    (SELECT COUNT(*) FROM app.user_advice_history
     WHERE user_id IN ('acct:004k_verify_a', 'acct:004k_verify_b')) AS remaining_advice
) AS cleanup;
