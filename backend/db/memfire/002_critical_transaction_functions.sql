begin;

-- Fault injection is intentionally unavailable through the public RPC.
-- Tests may SET LOCAL diet_secretary.failpoint inside an isolated transaction.
create or replace function diet_private.raise_at(p_point text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if current_setting('diet_secretary.failpoint', true) = p_point then
    raise exception 'INJECTED_FAILURE:%', p_point using errcode = 'P0001';
  end if;
end $$;

create or replace function diet_private.update_profile_transaction(
  p_user_id text, p_patch jsonb, p_source text, p_now timestamptz, p_expected_version integer default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_current public.user_profiles%rowtype; v_version integer; v_profile jsonb; v_created timestamptz;
begin
  insert into public.users(user_id,last_active_at,created_at) values(p_user_id,p_now,p_now)
  on conflict(user_id) do nothing;
  select * into v_current from public.user_profiles where user_id=p_user_id for update;
  if p_expected_version is not null and coalesce(v_current.profile_version,0) <> p_expected_version then
    raise exception 'PROFILE_VERSION_CONFLICT';
  end if;
  v_version := coalesce(v_current.profile_version,0)+1;
  v_profile := coalesce(v_current.profile_json,'{}'::jsonb) || coalesce(p_patch,'{}'::jsonb);
  v_created := coalesce(v_current.created_at,p_now);
  insert into public.user_profiles values(p_user_id,v_version,v_profile,v_created,p_now)
  on conflict(user_id) do update set profile_version=excluded.profile_version,profile_json=excluded.profile_json,updated_at=excluded.updated_at;
  perform diet_private.raise_at('profile_after_current');
  insert into public.profile_revisions(user_id,profile_version,snapshot_json,changed_fields_json,source,created_at)
  values(p_user_id,v_version,v_profile,to_jsonb(array(select jsonb_object_keys(coalesce(p_patch,'{}'::jsonb)))),p_source,p_now);
  return jsonb_build_object('userId',p_user_id,'profileVersion',v_version,'profile',v_profile,'createdAt',v_created,'updatedAt',p_now);
end $$;

create or replace function diet_private.activate_initial_plan_transaction(
  p_user_id text, p_plan_id uuid, p_started timestamptz, p_ends timestamptz, p_reminder timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_plan public.user_plan_versions%rowtype; v_status public.user_service_status%rowtype;
begin
  select * into v_plan from public.user_plan_versions where user_id=p_user_id and plan_id=p_plan_id for update;
  select * into v_status from public.user_service_status where user_id=p_user_id for update;
  if not found or v_status.status <> 'profile_confirmed' then raise exception 'SERVICE_NOT_PROFILE_CONFIRMED'; end if;
  if v_plan.plan_id is null or v_plan.status <> 'draft' then raise exception 'PLAN_NOT_DRAFT'; end if;
  update public.user_plan_versions set status='active',activated_at=p_started,paused_at=null where plan_id=p_plan_id;
  insert into public.plan_state_transitions(plan_id,user_id,from_status,to_status,reason,occurred_at)
  values(p_plan_id,p_user_id,'draft','active','official_plan_delivered',p_started);
  perform diet_private.raise_at('activation_after_plan');
  update public.user_service_status set status='trial_active',trial_started_at=p_started,trial_ends_at=p_ends,
    renewal_reminder_at=p_reminder,official_plan_id=p_plan_id,updated_at=p_started where user_id=p_user_id;
  insert into public.user_service_transitions(user_id,from_status,to_status,reason,occurred_at)
  values(p_user_id,'profile_confirmed','trial_active','first_official_plan_delivered',p_started);
  return jsonb_build_object('planId',p_plan_id,'userId',p_user_id,'status','active','trialStatus','trial_active');
end $$;

create or replace function diet_private.merge_identity_transaction(
  p_source text, p_target text, p_now timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_merge uuid := gen_random_uuid(); v_event record; v_duplicate uuid; v_hash text;
begin
  if p_source !~ '^anon:' or p_target !~ '^acct:' then raise exception 'INVALID_MERGE_IDENTITIES'; end if;
  insert into public.user_merges(merge_id,source_user_id,target_user_id,status,merged_at)
  values(v_merge,p_source,p_target,'completed',p_now);
  for v_event in select * from public.user_events where user_id=p_source order by recorded_at loop
    v_hash := encode(digest(v_event.event_type||'|'||v_event.occurred_at||'|'||v_event.payload_json::text,'sha256'),'hex');
    select event_id into v_duplicate from public.user_events
      where user_id=p_target and ((v_event.idempotency_key is not null and idempotency_key=v_event.idempotency_key)
      or encode(digest(event_type||'|'||occurred_at||'|'||payload_json::text,'sha256'),'hex')=v_hash) limit 1;
    if v_duplicate is null then
      update public.user_events set user_id=p_target,
        status=case when event_type in ('menstrual_period_start','menstrual_symptom') then 'restricted_pending_consent' else status end
        where event_id=v_event.event_id;
      insert into public.event_merge_audit(merge_id,source_event_id,target_event_id,action,event_hash,created_at)
      values(v_merge,v_event.event_id,v_event.event_id,
        case when v_event.event_type in ('menstrual_period_start','menstrual_symptom') then 'migrated_restricted' else 'migrated' end,v_hash,p_now);
    else
      insert into public.event_merge_audit(merge_id,source_event_id,target_event_id,action,event_hash,created_at)
      values(v_merge,v_event.event_id,v_duplicate,'deduplicated',v_hash,p_now);
    end if;
    v_duplicate := null;
  end loop;
  perform diet_private.raise_at('merge_after_events');
  update public.user_identities set user_id=p_target,last_seen_at=p_now where user_id=p_source;
  update public.users set account_status='merged',merged_into_user_id=p_target where user_id=p_source;
  return jsonb_build_object('mergeId',v_merge,'sourceUserId',p_source,'targetUserId',p_target,'status','completed','mergedAt',p_now);
end $$;

revoke all on schema diet_private from public, anon, authenticated;
revoke all on all functions in schema diet_private from public, anon, authenticated;

-- Admin-only harness: the inner BEGIN/EXCEPTION block is a PostgreSQL
-- subtransaction. Its writes are rolled back before the error text is returned.
create or replace function diet_private.capture_expected_failure(p_sql text, p_failpoint text)
returns text language plpgsql security invoker set search_path = '' as $$
begin
  perform set_config('diet_secretary.failpoint',p_failpoint,true);
  begin
    execute p_sql;
    raise exception 'EXPECTED_FAILURE_DID_NOT_OCCUR';
  exception when others then
    if sqlerrm = 'EXPECTED_FAILURE_DID_NOT_OCCUR' then raise; end if;
    return sqlerrm;
  end;
end $$;

revoke all on function diet_private.capture_expected_failure(text,text) from public, anon, authenticated;

commit;
