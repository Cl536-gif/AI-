-- REVIEW ONLY — 审核通过后再复制到腾讯云 DMC 执行。
-- 作用：在同一个数据库事务中更新普通用户档案，并追加一条历史快照。
-- 重要：经期数据不得进入本函数；经期档案由独立表和独立授权流程处理。

BEGIN;

CREATE OR REPLACE FUNCTION app.save_current_user_profile(
  p_profile jsonb,
  p_source varchar DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar;
  v_user_status varchar;
  v_schema_version smallint;
  v_snapshot jsonb;
BEGIN
  v_user_id := app.current_user_id();

  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION '缺少当前用户身份';
  END IF;

  IF p_profile IS NULL OR jsonb_typeof(p_profile) <> 'object' THEN
    RAISE EXCEPTION 'p_profile 必须是 JSON 对象';
  END IF;

  -- 普通档案和经期档案严格分离。
  IF p_profile ? 'menstrualTracking' THEN
    RAISE EXCEPTION '普通档案不能包含 menstrualTracking';
  END IF;

  -- 顶层只接受 userDataContract.js 定义的普通档案字段。
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_profile) AS top_key(key)
    WHERE top_key.key NOT IN ('schemaVersion', 'body', 'diet')
  ) THEN
    RAISE EXCEPTION 'p_profile 含有未定义的顶层字段';
  END IF;

  IF NOT (p_profile ? 'schemaVersion')
     OR NOT (p_profile ? 'body')
     OR NOT (p_profile ? 'diet') THEN
    RAISE EXCEPTION 'p_profile 必须包含 schemaVersion、body、diet';
  END IF;

  IF jsonb_typeof(p_profile -> 'body') <> 'object'
     OR jsonb_typeof(p_profile -> 'diet') <> 'object' THEN
    RAISE EXCEPTION 'body 和 diet 必须是 JSON 对象';
  END IF;

  v_schema_version := (p_profile ->> 'schemaVersion')::smallint;
  IF v_schema_version <> 1 THEN
    RAISE EXCEPTION '暂不支持 schemaVersion=%', v_schema_version;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_profile -> 'body') AS body_key(key)
    WHERE body_key.key NOT IN (
      'equationSex',
      'ageYears',
      'heightCm',
      'currentWeightKg',
      'targetWeightKg',
      'dailyActivity',
      'recentWeightChange'
    )
  ) THEN
    RAISE EXCEPTION 'body 含有未定义字段';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_profile -> 'diet') AS diet_key(key)
    WHERE diet_key.key NOT IN (
      'scene',
      'cafeteriaMode',
      'budgetCnyPerMeal',
      'tastePreferences',
      'restrictions',
      'goals',
      'exerciseBaseline'
    )
  ) THEN
    RAISE EXCEPTION 'diet 含有未定义字段';
  END IF;

  -- 首次保存时建立用户身份；已存在则不覆盖。
  INSERT INTO app.users (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT status
  INTO v_user_status
  FROM app.users
  WHERE user_id = v_user_id;

  IF v_user_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION '当前用户不是 active 状态，不能更新档案';
  END IF;

  INSERT INTO app.user_profiles (
    user_id,
    schema_version,
    equation_sex,
    age_years,
    height_cm,
    current_weight_kg,
    target_weight_kg,
    daily_activity,
    recent_weight_change,
    scene,
    cafeteria_mode,
    budget_cny_per_meal,
    taste_preferences,
    restrictions,
    goals,
    exercise_baseline
  )
  VALUES (
    v_user_id,
    v_schema_version,
    p_profile #>> '{body,equationSex}',
    (p_profile #>> '{body,ageYears}')::numeric,
    (p_profile #>> '{body,heightCm}')::numeric,
    (p_profile #>> '{body,currentWeightKg}')::numeric,
    (p_profile #>> '{body,targetWeightKg}')::numeric,
    p_profile #>> '{body,dailyActivity}',
    p_profile #>> '{body,recentWeightChange}',
    COALESCE(p_profile #>> '{diet,scene}', 'unknown'),
    COALESCE(p_profile #>> '{diet,cafeteriaMode}', 'unknown'),
    (p_profile #>> '{diet,budgetCnyPerMeal}')::numeric,
    COALESCE(p_profile #> '{diet,tastePreferences}', '[]'::jsonb),
    COALESCE(p_profile #> '{diet,restrictions}', '[]'::jsonb),
    COALESCE(p_profile #> '{diet,goals}', '[]'::jsonb),
    p_profile #>> '{diet,exerciseBaseline}'
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    schema_version = EXCLUDED.schema_version,
    equation_sex = EXCLUDED.equation_sex,
    age_years = EXCLUDED.age_years,
    height_cm = EXCLUDED.height_cm,
    current_weight_kg = EXCLUDED.current_weight_kg,
    target_weight_kg = EXCLUDED.target_weight_kg,
    daily_activity = EXCLUDED.daily_activity,
    recent_weight_change = EXCLUDED.recent_weight_change,
    scene = EXCLUDED.scene,
    cafeteria_mode = EXCLUDED.cafeteria_mode,
    budget_cny_per_meal = EXCLUDED.budget_cny_per_meal,
    taste_preferences = EXCLUDED.taste_preferences,
    restrictions = EXCLUDED.restrictions,
    goals = EXCLUDED.goals,
    exercise_baseline = EXCLUDED.exercise_baseline,
    updated_at = clock_timestamp();

  -- 从数据库已保存的规范值生成历史快照，不直接信任输入 JSON。
  SELECT jsonb_build_object(
    'schemaVersion', up.schema_version,
    'body', jsonb_build_object(
      'equationSex', up.equation_sex,
      'ageYears', up.age_years,
      'heightCm', up.height_cm,
      'currentWeightKg', up.current_weight_kg,
      'targetWeightKg', up.target_weight_kg,
      'dailyActivity', up.daily_activity,
      'recentWeightChange', up.recent_weight_change
    ),
    'diet', jsonb_build_object(
      'scene', up.scene,
      'cafeteriaMode', up.cafeteria_mode,
      'budgetCnyPerMeal', up.budget_cny_per_meal,
      'tastePreferences', up.taste_preferences,
      'restrictions', up.restrictions,
      'goals', up.goals,
      'exerciseBaseline', up.exercise_baseline
    )
  )
  INTO v_snapshot
  FROM app.user_profiles AS up
  WHERE up.user_id = v_user_id;

  -- 与上面的 UPSERT 同属一个函数调用；这里失败时，档案更新也会一起回滚。
  INSERT INTO app.profile_revisions (
    user_id,
    schema_version,
    profile_snapshot,
    source
  )
  VALUES (
    v_user_id,
    v_schema_version,
    v_snapshot,
    p_source
  );

  RETURN v_snapshot;
END;
$function$;

ALTER FUNCTION app.save_current_user_profile(jsonb, varchar)
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.save_current_user_profile(jsonb, varchar)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app.save_current_user_profile(jsonb, varchar)
TO diet_app, diet_owner;

COMMENT ON FUNCTION app.save_current_user_profile(jsonb, varchar) IS
  '原子保存普通用户档案并追加历史快照；禁止包含经期数据。输入字段使用 userDataContract.js 的 camelCase 契约。';

COMMIT;

-- 审核重点：
-- 1. 入参只有 p_profile 与 p_source，没有可由客户端伪造的 user_id。
-- 2. currentWeightKg 写入 user_profiles.current_weight_kg；单次称重仍写 body_measurement.payload.weightKg。
-- 3. 普通历史快照不包含 menstrualTracking。
-- 4. UPSERT 与 profile_revisions INSERT 处于同一函数事务中。
-- 5. p_source 仍由 profile_revisions_source_chk 约束，便于故障注入验证原子回滚。
