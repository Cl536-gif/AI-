BEGIN;

CREATE TABLE IF NOT EXISTS app.wecom_identities (
  external_subject_hash text PRIMARY KEY CHECK (external_subject_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  recipient_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.wecom_onboarding (
  user_id uuid PRIMARY KEY REFERENCES app.wecom_identities(user_id),
  intro_version text,
  intro_sent_at timestamptz,
  service_choice text CHECK (service_choice IN ('free', 'subscribed')),
  graph_started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.wecom_deletion_requests (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.wecom_identities(user_id),
  request_type text NOT NULL CHECK (request_type IN ('explicit_deletion', 'ambiguous_stop')),
  status text NOT NULL CHECK (status IN ('recorded', 'pending_confirmation')),
  source_message_hash text NOT NULL CHECK (source_message_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.wecom_inbound_jobs (
  sequence_id bigserial PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  message_key text NOT NULL UNIQUE,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  graph_operation_id uuid NOT NULL UNIQUE,
  external_subject_hash text NOT NULL CHECK (external_subject_hash ~ '^[a-f0-9]{64}$'),
  thread_id text NOT NULL,
  payload_cipher text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','processed','completed','state_conflict','dead_letter')),
  stage text NOT NULL DEFAULT 'accepted',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_by text,
  locked_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wecom_inbound_claim
  ON app.wecom_inbound_jobs(status, locked_until, sequence_id);
CREATE INDEX IF NOT EXISTS idx_wecom_inbound_thread_fifo
  ON app.wecom_inbound_jobs(thread_id, sequence_id, status);

CREATE TABLE IF NOT EXISTS app.wecom_graph_receipts (
  request_id uuid PRIMARY KEY REFERENCES app.wecom_inbound_jobs(request_id),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  graph_operation_id uuid NOT NULL UNIQUE,
  reply_sha256 text NOT NULL CHECK (reply_sha256 ~ '^[a-f0-9]{64}$'),
  reply_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.wecom_outbound_messages (
  outbound_id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES app.wecom_inbound_jobs(request_id),
  request_json_cipher text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_by text,
  locked_until timestamptz,
  upstream_message_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON app.wecom_identities, app.wecom_onboarding,
  app.wecom_deletion_requests, app.wecom_inbound_jobs,
  app.wecom_graph_receipts, app.wecom_outbound_messages FROM PUBLIC;

COMMIT;
