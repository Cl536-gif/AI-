-- Run after the merge. All four ordinary write paths from the old guest must fail.
BEGIN;

SELECT set_config(
  'app.current_user_id',
  'anon:fkshare_20260818_190000_k7m2',
  true
);
SELECT set_config('app.test_event_rejected', 'false', true);
SELECT set_config('app.test_profile_rejected', 'false', true);
SELECT set_config('app.test_consent_rejected', 'false', true);
SELECT set_config('app.test_confirmation_rejected', 'false', true);
SELECT set_config('app.test_event_sqlstate', 'none', true);
SELECT set_config('app.test_profile_sqlstate', 'none', true);
SELECT set_config('app.test_consent_sqlstate', 'none', true);
SELECT set_config('app.test_confirmation_sqlstate', 'none', true);
SET LOCAL ROLE diet_app;

DO $test$
BEGIN
  BEGIN
    PERFORM app.append_current_user_event(
      jsonb_build_object(
        'eventType', 'meal',
        'occurredAt', clock_timestamp(),
        'payload', jsonb_build_object('attempt', 'after-concurrent-merge'),
        'source', 'user',
        'idempotencyKey', 'fkshare-after-merge-must-fail'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.test_event_rejected', 'true', true);
    PERFORM set_config('app.test_event_sqlstate', SQLSTATE, true);
  END;

  BEGIN
    PERFORM app.save_current_user_profile(
      '{
        "schemaVersion":1,
        "body":{
          "equationSex":null,"ageYears":null,"heightCm":165,
          "currentWeightKg":null,"targetWeightKg":null,
          "dailyActivity":null,"recentWeightChange":null
        },
        "diet":{
          "scene":"unknown","cafeteriaMode":"unknown",
          "budgetCnyPerMeal":null,"tastePreferences":[],
          "restrictions":[],"goals":[],"exerciseBaseline":null
        }
      }'::jsonb,
      'user'
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.test_profile_rejected', 'true', true);
    PERFORM set_config('app.test_profile_sqlstate', SQLSTATE, true);
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
    PERFORM set_config('app.test_consent_rejected', 'true', true);
    PERFORM set_config('app.test_consent_sqlstate', SQLSTATE, true);
  END;

  BEGIN
    PERFORM app.begin_current_long_term_profile_confirmation(
      'fkshare-onboarding-after-merge',
      'fkshare-prompt-after-merge',
      '{"body.heightCm":165}'::jsonb,
      clock_timestamp()
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.test_confirmation_rejected', 'true', true);
    PERFORM set_config('app.test_confirmation_sqlstate', SQLSTATE, true);
  END;
END
$test$;

SELECT
  CASE WHEN
    current_setting('app.test_event_rejected') = 'true'
    AND current_setting('app.test_profile_rejected') = 'true'
    AND current_setting('app.test_consent_rejected') = 'true'
    AND current_setting('app.test_confirmation_rejected') = 'true'
  THEN 'PASS' ELSE 'FAIL' END AS status,
  current_setting('app.test_event_rejected') AS event_rejected,
  current_setting('app.test_event_sqlstate') AS event_sqlstate,
  current_setting('app.test_profile_rejected') AS profile_rejected,
  current_setting('app.test_profile_sqlstate') AS profile_sqlstate,
  current_setting('app.test_consent_rejected') AS consent_rejected,
  current_setting('app.test_consent_sqlstate') AS consent_sqlstate,
  current_setting('app.test_confirmation_rejected') AS confirmation_rejected,
  current_setting('app.test_confirmation_sqlstate') AS confirmation_sqlstate;

ROLLBACK;
