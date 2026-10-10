CREATE TABLE data_import_jobs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  table_id uuid NOT NULL,
  command_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES accounts(id),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  authority_actor jsonb NOT NULL CHECK (jsonb_typeof(authority_actor) = 'object'),
  project_revision bigint NOT NULL CHECK (project_revision > 0),
  environment_revision bigint NOT NULL CHECK (environment_revision > 0),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  sealed_execution text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'partially_succeeded')),
  phase text NOT NULL DEFAULT 'execute' CHECK (phase IN ('execute', 'reconcile')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  cancellation_requested boolean NOT NULL DEFAULT false,
  outcome_unknown boolean NOT NULL DEFAULT false,
  retryable boolean NOT NULL DEFAULT true,
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  lease_id uuid,
  lease_expires_at timestamptz,
  dispatch_digest text CHECK (dispatch_digest IS NULL OR dispatch_digest ~ '^[a-f0-9]{64}$'),
  dispatched_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (binding_id, environment_id, project_id, org_id) REFERENCES service_bindings(id, environment_id, project_id, org_id),
  UNIQUE (actor_id, command_id),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled', 'partially_succeeded')) = (completed_at IS NOT NULL)),
  CHECK (state NOT IN ('succeeded', 'failed', 'cancelled', 'partially_succeeded') OR lease_id IS NULL)
);
CREATE INDEX data_import_jobs_work_idx ON data_import_jobs(next_attempt_at, created_at, id) WHERE state IN ('queued', 'running', 'cancel_requested');
CREATE INDEX data_import_jobs_scope_idx ON data_import_jobs(org_id, project_id, environment_id, id);

CREATE TABLE data_import_job_attempts (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES data_import_jobs(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  lease_id uuid NOT NULL UNIQUE,
  phase text NOT NULL CHECK (phase IN ('execute', 'reconcile')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled', 'interrupted')),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  UNIQUE (operation_id, attempt)
);
CREATE TABLE data_import_job_commands (
  actor_id uuid NOT NULL REFERENCES accounts(id),
  command_id uuid NOT NULL,
  operation_id uuid NOT NULL REFERENCES data_import_jobs(id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  PRIMARY KEY (actor_id, command_id)
);
CREATE TABLE data_import_job_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  operation_id uuid NOT NULL REFERENCES data_import_jobs(id),
  action text NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
