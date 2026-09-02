begin;

create extension if not exists pgcrypto;
create schema if not exists diet_private;

create table if not exists public.users (
  user_id text primary key,
  last_active_at timestamptz not null,
  created_at timestamptz not null,
  timezone text default 'Asia/Shanghai',
  locale text default 'zh-CN',
  account_status text not null default 'active',
  merged_into_user_id text references public.users(user_id)
);

create table if not exists public.user_profiles (
  user_id text primary key references public.users(user_id) on delete cascade,
  profile_version integer not null check (profile_version > 0),
  profile_json jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.profile_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(user_id) on delete cascade,
  profile_version integer not null,
  snapshot_json jsonb not null,
  changed_fields_json jsonb not null,
  source text not null,
  created_at timestamptz not null,
  unique(user_id, profile_version)
);

create table if not exists public.user_events (
  event_id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(user_id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  payload_json jsonb not null,
  source text not null,
  idempotency_key text,
  supersedes_event_id uuid references public.user_events(event_id),
  status text not null default 'active',
  unique(user_id, idempotency_key)
);
create index if not exists idx_user_events_user_time on public.user_events(user_id, occurred_at desc);
create index if not exists idx_user_events_user_type_time on public.user_events(user_id, event_type, occurred_at desc);

create table if not exists public.user_service_status (
  user_id text primary key references public.users(user_id) on delete cascade,
  status text not null,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  renewal_reminder_at timestamptz,
  official_plan_id uuid,
  updated_at timestamptz not null
);

create table if not exists public.user_service_transitions (
  transition_id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(user_id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text not null,
  occurred_at timestamptz not null
);

create table if not exists public.user_merges (
  merge_id uuid primary key default gen_random_uuid(),
  source_user_id text not null unique references public.users(user_id),
  target_user_id text not null references public.users(user_id),
  status text not null,
  merged_at timestamptz not null
);

create table if not exists public.event_merge_audit (
  audit_id uuid primary key default gen_random_uuid(),
  merge_id uuid not null references public.user_merges(merge_id) on delete cascade,
  source_event_id uuid not null,
  target_event_id uuid,
  action text not null,
  event_hash text not null,
  created_at timestamptz not null
);

create table if not exists public.profile_merge_conflicts (
  conflict_id uuid primary key default gen_random_uuid(),
  merge_id uuid not null references public.user_merges(merge_id) on delete cascade,
  field_path text not null,
  account_value_json jsonb not null,
  guest_value_json jsonb not null,
  account_updated_at timestamptz,
  guest_updated_at timestamptz,
  account_stale_over_30_days boolean not null default false,
  resolution_status text not null default 'pending',
  created_at timestamptz not null
);

create table if not exists public.energy_calculations (
  calculation_id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(user_id) on delete cascade,
  formula_id text not null,
  formula_version text not null,
  inputs_json jsonb not null,
  assumptions_json jsonb not null,
  outputs_json jsonb not null,
  source_refs_json jsonb not null,
  created_at timestamptz not null
);

create table if not exists public.user_plan_versions (
  plan_id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(user_id) on delete cascade,
  plan_version integer not null,
  status text not null,
  calculation_id uuid references public.energy_calculations(calculation_id),
  parent_plan_id uuid references public.user_plan_versions(plan_id),
  plan_json jsonb not null,
  change_reason text not null,
  created_at timestamptz not null,
  activated_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  unique(user_id, plan_version)
);
create unique index if not exists idx_one_active_plan_per_user
  on public.user_plan_versions(user_id) where status = 'active';
alter table public.user_service_status drop constraint if exists user_service_status_official_plan_id_fkey;
alter table public.user_service_status add constraint user_service_status_official_plan_id_fkey
  foreign key (official_plan_id) references public.user_plan_versions(plan_id);

create table if not exists public.plan_state_transitions (
  transition_id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.user_plan_versions(plan_id) on delete cascade,
  user_id text not null references public.users(user_id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text not null,
  occurred_at timestamptz not null
);

-- Remaining single-table records used by UserStore.
create table if not exists public.user_advice_history (
  advice_id uuid primary key default gen_random_uuid(), user_id text not null references public.users(user_id) on delete cascade,
  advice_type text not null, service_mode text not null, content text not null, metadata_json jsonb not null,
  thread_id text, idempotency_key text not null, created_at timestamptz not null, unique(user_id,idempotency_key)
);
create table if not exists public.user_consents (
  consent_id uuid primary key default gen_random_uuid(), user_id text not null references public.users(user_id) on delete cascade,
  consent_type text not null, status text not null, recorded_at timestamptz not null, source text not null
);
create table if not exists public.user_identities (
  identity_type text not null, external_subject_hash text not null, user_id text not null references public.users(user_id) on delete cascade,
  created_at timestamptz not null, last_seen_at timestamptz not null, primary key(identity_type,external_subject_hash)
);
create table if not exists public.user_notifications (
  notification_id uuid primary key default gen_random_uuid(), user_id text not null references public.users(user_id) on delete cascade,
  notification_type text not null, dedupe_key text not null, scheduled_at timestamptz not null, status text not null default 'pending',
  attempts integer not null default 0, created_at timestamptz not null, sent_at timestamptz, unique(user_id,dedupe_key)
);
create table if not exists public.plan_revision_commands (
  command_id text primary key, user_id text not null references public.users(user_id) on delete cascade,
  plan_id uuid references public.user_plan_versions(plan_id), status text not null, created_at timestamptz not null, updated_at timestamptz not null
);

commit;
