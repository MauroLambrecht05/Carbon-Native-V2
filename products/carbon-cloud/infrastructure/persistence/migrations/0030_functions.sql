-- Functions and schedules. A function is a name with a pointer to one of its
-- own immutable revisions. An execution is durable, pinned to the revision that
-- was active when it was created, and runs on a worker lease, which is also the
-- only way its secrets reach a worker.
CREATE TABLE functions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  active_revision integer NOT NULL CHECK (active_revision > 0),
  latest_revision integer NOT NULL CHECK (latest_revision >= active_revision),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, name),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
CREATE INDEX functions_scope_idx ON functions (org_id, project_id, environment_id, id);

CREATE TABLE function_revisions (
  function_id uuid NOT NULL REFERENCES functions(id),
  number integer NOT NULL CHECK (number > 0),
  code text NOT NULL CHECK (octet_length(code) BETWEEN 1 AND 1048576),
  code_digest text NOT NULL CHECK (code_digest ~ '^[a-f0-9]{64}$'),
  secret_names text[] NOT NULL CHECK (cardinality(secret_names) <= 20),
  timeout_seconds integer NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 300),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (function_id, number)
);

CREATE TABLE function_schedules (
  id uuid PRIMARY KEY,
  function_id uuid NOT NULL REFERENCES functions(id),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 60 AND 604800),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'deleted')),
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX function_schedules_due_idx ON function_schedules (next_run_at) WHERE state = 'active';
CREATE INDEX function_schedules_function_idx ON function_schedules (function_id);

CREATE TABLE function_executions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  function_id uuid NOT NULL REFERENCES functions(id),
  -- The revision this execution runs, fixed when it is created. Deploying or activating another changes nothing here.
  revision_number integer NOT NULL,
  code_digest text NOT NULL CHECK (code_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule', 'retry')),
  schedule_id uuid REFERENCES function_schedules(id),
  -- The slot a scheduled execution was created for. One execution per schedule and slot, whatever races to create it.
  scheduled_for timestamptz,
  retry_of uuid REFERENCES function_executions(id),
  input jsonb NOT NULL,
  output jsonb,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 10),
  error_category text CHECK (error_category IS NULL OR error_category ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  created_by uuid REFERENCES accounts(id),
  deadline_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (function_id, revision_number) REFERENCES function_revisions(function_id, number),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id),
  UNIQUE (schedule_id, scheduled_for),
  CHECK ((trigger = 'schedule') = (schedule_id IS NOT NULL AND scheduled_for IS NOT NULL)),
  CHECK ((trigger = 'retry') = (retry_of IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed', 'timed_out', 'cancelled')) = (completed_at IS NOT NULL)),
  CHECK (output IS NULL OR state = 'succeeded')
);
CREATE INDEX function_executions_scope_idx ON function_executions (org_id, project_id, environment_id, function_id, id);
CREATE INDEX function_executions_open_idx ON function_executions (deadline_at) WHERE state IN ('queued', 'running');
CREATE INDEX function_executions_load_idx ON function_executions (environment_id) WHERE state IN ('queued', 'running');

CREATE FUNCTION protect_function_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'function_revisions' THEN
    RAISE EXCEPTION 'A function revision is immutable' USING ERRCODE = '23514', CONSTRAINT = 'function_revision_immutable';
  END IF;
  -- What an execution runs, and for whom, never changes. A finished execution never changes at all.
  IF NEW.function_id IS DISTINCT FROM OLD.function_id OR NEW.revision_number IS DISTINCT FROM OLD.revision_number OR NEW.code_digest IS DISTINCT FROM OLD.code_digest OR NEW.input IS DISTINCT FROM OLD.input
    OR NEW.environment_id IS DISTINCT FROM OLD.environment_id OR NEW.trigger IS DISTINCT FROM OLD.trigger OR NEW.retry_of IS DISTINCT FROM OLD.retry_of OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id THEN
    RAISE EXCEPTION 'An execution is pinned to what it was created with' USING ERRCODE = '23514', CONSTRAINT = 'function_execution_pinned';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'timed_out', 'cancelled') THEN
    RAISE EXCEPTION 'A finished execution cannot change' USING ERRCODE = '23514', CONSTRAINT = 'function_execution_final';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER function_revision_guard BEFORE UPDATE OR DELETE ON function_revisions FOR EACH ROW EXECUTE FUNCTION protect_function_record();
CREATE TRIGGER function_execution_guard BEFORE UPDATE ON function_executions FOR EACH ROW EXECUTE FUNCTION protect_function_record();

CREATE TABLE function_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_account_id, scope_key, key_digest)
);

CREATE TABLE function_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('function', 'function_execution', 'function_schedule')),
  resource_id uuid NOT NULL,
  actor_account_id uuid REFERENCES accounts(id),
  worker_id uuid REFERENCES workers(id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION record_function_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform_events (id, source, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, revision, request_id, occurred_at)
    VALUES (NEW.id, TG_TABLE_NAME, NEW.org_id, NEW.project_id, NEW.environment_id,
      CASE WHEN NEW.actor_account_id IS NOT NULL THEN 'account' WHEN NEW.worker_id IS NOT NULL THEN 'worker' ELSE 'system' END, COALESCE(NEW.actor_account_id, NEW.worker_id),
      NEW.action, NEW.resource_kind, NEW.resource_id, NEW.revision, NEW.request_id, NEW.created_at);
  RETURN NULL;
END;
$$;
CREATE TRIGGER platform_event AFTER INSERT ON function_events FOR EACH ROW EXECUTE FUNCTION record_function_event();
