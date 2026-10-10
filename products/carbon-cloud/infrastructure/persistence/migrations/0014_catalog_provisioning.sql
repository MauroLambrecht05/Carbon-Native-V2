-- Display revisions also change for child/provisioning progress. Execution
-- preconditions use separate authority revisions so sibling work cannot drift them.
ALTER TABLE projects ADD COLUMN authority_revision bigint NOT NULL DEFAULT 1 CHECK (authority_revision > 0);
ALTER TABLE environments ADD COLUMN authority_revision bigint NOT NULL DEFAULT 1 CHECK (authority_revision > 0);

CREATE TABLE operations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('environment.ensure', 'environment.pause', 'environment.resume')),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'partially_succeeded')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  project_revision bigint NOT NULL DEFAULT 1 CHECK (project_revision > 0),
  environment_revision bigint NOT NULL DEFAULT 1 CHECK (environment_revision > 0),
  idempotency_digest text NOT NULL CHECK (idempotency_digest ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  cancellation_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  lease_id uuid,
  lease_expires_at timestamptz,
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id),
  UNIQUE (id, environment_id, project_id, org_id),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX operations_environment_active_idx ON operations (environment_id) WHERE state IN ('queued', 'running', 'cancel_requested');
CREATE INDEX operations_work_idx ON operations (created_at, id) WHERE state IN ('queued', 'running', 'cancel_requested');

CREATE TABLE service_bindings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  owner text NOT NULL CHECK (owner IN ('database', 'registry')),
  remote_resource_id text CHECK (remote_resource_id IS NULL OR char_length(remote_resource_id) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'paused', 'failed')),
  desired_state text NOT NULL DEFAULT 'active' CHECK (desired_state IN ('active', 'paused')),
  operation_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id),
  FOREIGN KEY (operation_id, environment_id, project_id, org_id) REFERENCES operations(id, environment_id, project_id, org_id),
  UNIQUE (environment_id, owner),
  UNIQUE (id, environment_id, project_id, org_id),
  CHECK (state NOT IN ('ready', 'paused') OR remote_resource_id IS NOT NULL)
);
CREATE UNIQUE INDEX service_bindings_remote_idx ON service_bindings (owner, remote_resource_id) WHERE remote_resource_id IS NOT NULL;

CREATE TABLE operation_steps (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ensure', 'pause', 'resume')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (operation_id, environment_id, project_id, org_id) REFERENCES operations(id, environment_id, project_id, org_id),
  FOREIGN KEY (binding_id, environment_id, project_id, org_id) REFERENCES service_bindings(id, environment_id, project_id, org_id),
  UNIQUE (operation_id, binding_id)
);

CREATE TABLE operation_attempts (
  id uuid PRIMARY KEY,
  step_id uuid NOT NULL REFERENCES operation_steps(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  lease_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'interrupted')),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  UNIQUE (step_id, attempt)
);
