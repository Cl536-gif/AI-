-- 经期档案 RPC：原子回滚故障注入测试（修正版）
-- 预期最终结果：menstrual_atomic_rollback_result = PASS
-- 本脚本最后执行 ROLLBACK，不保留测试数据。

BEGIN;

SET LOCAL ROLE diet_app;

-- 生成本次测试专用用户，并写入当前业务身份。
SELECT set_config(
  'app.current_user_id',
  'menstrual_atomic_' || replace(gen_random_uuid()::text, '-', ''),
  true
) AS test_user_id;

INSERT INTO app.users (user_id)
VALUES (app.current_user_id());

-- 经期档案写入前必须存在当前有效授权。
INSERT INTO app.user_consents (
  user_id,
  consent_type,
  status,
  recorded_at,
  source
)
VALUES (
  app.current_user_id(),
  'menstrual_tracking',
  'granted',
  clock_timestamp(),
  'user'
);

-- 建立基线：当前档案为 applicable / active，并生成第 1 条历史快照。
SELECT app.save_current_user_menstrual_profile(
  '{
    "applicability": "applicable",
    "status": "active"
  }'::jsonb,
  'user'
) AS baseline_snapshot;

-- 初始化故障检测结果。
SELECT set_config('app.test_failure_was_caught', 'false', true);
SELECT set_config('app.test_failure_sqlstate', '', true);

-- 故障注入：先尝试把状态改成 declined，再用非法 source 让历史快照写入失败。
-- RPC 内的档案 UPSERT 与历史 INSERT 必须作为一个整体回滚。
DO $test$
BEGIN
  PERFORM app.save_current_user_menstrual_profile(
    '{
      "applicability": "applicable",
      "status": "declined"
    }'::jsonb,
    '__force_history_failure__'
  );
EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config('app.test_failure_was_caught', 'true', true);
    PERFORM set_config('app.test_failure_sqlstate', SQLSTATE, true);
END;
$test$;

-- 修正后的自动核对：
-- SQLSTATE 作为诊断信息展示，不再错误地用另一个异常码决定 PASS/FAIL。
-- 真正的通过标准是：异常被捕获，且档案与历史都完整保持基线。
WITH verification AS (
  SELECT
    current_setting('app.test_failure_was_caught', true)::boolean
      AS failure_was_caught,
    nullif(current_setting('app.test_failure_sqlstate', true), '')
      AS failure_sqlstate,
    ump.applicability,
    ump.status,
    (
      SELECT count(*)
      FROM app.menstrual_profile_revisions AS mpr
      WHERE mpr.user_id = ump.user_id
    ) AS revision_count
  FROM app.user_menstrual_profiles AS ump
  WHERE ump.user_id = app.current_user_id()
)
SELECT
  CASE
    WHEN failure_was_caught = true
      AND failure_sqlstate IS NOT NULL
      AND applicability = 'applicable'
      AND status = 'active'
      AND revision_count = 1
    THEN 'PASS'
    ELSE 'FAIL'
  END AS menstrual_atomic_rollback_result,
  failure_was_caught,
  failure_sqlstate,
  (failure_sqlstate = 'P0001') AS injected_failure_code_is_expected,
  applicability AS applicability_should_remain_applicable,
  status AS status_should_remain_active,
  revision_count AS revision_count_should_be_1
FROM verification;

ROLLBACK;
