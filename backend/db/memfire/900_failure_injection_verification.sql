\set ON_ERROR_STOP on
\echo '=== MemFire critical transaction failure-injection verification ==='

-- Each case runs in its own transaction and is rolled back after evidence is printed.
begin;
insert into public.users(user_id,last_active_at,created_at) values('test:txn:profile',now(),now()) on conflict do nothing;
select 'profile/before' label, count(*) current_rows, (select count(*) from public.profile_revisions where user_id='test:txn:profile') revision_rows from public.user_profiles where user_id='test:txn:profile';
select diet_private.update_profile_transaction('test:txn:profile','{"currentWeightKg":60}','test',now(),null);
select 'profile/normal_after' label, count(*) current_rows, (select count(*) from public.profile_revisions where user_id='test:txn:profile') revision_rows from public.user_profiles where user_id='test:txn:profile';
rollback;

begin;
insert into public.users(user_id,last_active_at,created_at) values('test:txn:profile',now(),now()) on conflict do nothing;
set local diet_secretary.failpoint='profile_after_current';
select 'profile/injected_error' label, diet_private.capture_expected_failure(
  $$select diet_private.update_profile_transaction('test:txn:profile','{"currentWeightKg":60}','test',now(),null)$$,
  'profile_after_current') error;
select 'profile/rollback_after' label, count(*) current_rows, (select count(*) from public.profile_revisions where user_id='test:txn:profile') revision_rows from public.user_profiles where user_id='test:txn:profile';
rollback;

begin;
insert into public.users(user_id,last_active_at,created_at) values('test:txn:activation',now(),now());
insert into public.user_service_status(user_id,status,updated_at) values('test:txn:activation','profile_confirmed',now());
insert into public.user_plan_versions(user_id,plan_version,status,plan_json,change_reason,created_at) values('test:txn:activation',1,'draft','{}','test',now()) returning plan_id \gset
select diet_private.activate_initial_plan_transaction('test:txn:activation',:'plan_id',now(),now()+interval '14 days',now()+interval '13 days');
select 'activation/normal_after' label,(select status from public.user_plan_versions where plan_id=:'plan_id') plan_status,(select status from public.user_service_status where user_id='test:txn:activation') service_status;
rollback;

begin;
insert into public.users(user_id,last_active_at,created_at) values('test:txn:activation',now(),now());
insert into public.user_service_status(user_id,status,updated_at) values('test:txn:activation','profile_confirmed',now());
insert into public.user_plan_versions(user_id,plan_version,status,plan_json,change_reason,created_at) values('test:txn:activation',1,'draft','{}','test',now()) returning plan_id \gset
set local diet_secretary.failpoint='activation_after_plan';
select 'activation/injected_error' label, diet_private.capture_expected_failure(
  format($sql$select diet_private.activate_initial_plan_transaction('test:txn:activation',%L::uuid,now(),now()+interval '14 days',now()+interval '13 days')$sql$, :'plan_id'),
  'activation_after_plan') error;
select 'activation/rollback_after' label,(select status from public.user_plan_versions where plan_id=:'plan_id') plan_status,(select status from public.user_service_status where user_id='test:txn:activation') service_status;
rollback;

begin;
insert into public.users(user_id,last_active_at,created_at) values('anon:test-merge',now(),now()),('acct:test-merge',now(),now());
insert into public.user_events(user_id,event_type,occurred_at,recorded_at,payload_json,source,idempotency_key) values('anon:test-merge','meal_log',now(),now(),'{"meal":"lunch"}','test','merge-1');
select diet_private.merge_identity_transaction('anon:test-merge','acct:test-merge',now());
select 'merge/normal_after' label,(select account_status from public.users where user_id='anon:test-merge') source_status,(select count(*) from public.user_events where user_id='acct:test-merge') target_events;
rollback;

begin;
insert into public.users(user_id,last_active_at,created_at) values('anon:test-merge',now(),now()),('acct:test-merge',now(),now());
insert into public.user_events(user_id,event_type,occurred_at,recorded_at,payload_json,source,idempotency_key) values('anon:test-merge','meal_log',now(),now(),'{"meal":"lunch"}','test','merge-1');
set local diet_secretary.failpoint='merge_after_events';
select 'merge/injected_error' label, diet_private.capture_expected_failure(
  $$select diet_private.merge_identity_transaction('anon:test-merge','acct:test-merge',now())$$,
  'merge_after_events') error;
select 'merge/rollback_after' label,(select account_status from public.users where user_id='anon:test-merge') source_status,(select count(*) from public.user_events where user_id='anon:test-merge') source_events,(select count(*) from public.user_events where user_id='acct:test-merge') target_events,(select count(*) from public.user_merges where source_user_id='anon:test-merge') merge_rows;
rollback;
