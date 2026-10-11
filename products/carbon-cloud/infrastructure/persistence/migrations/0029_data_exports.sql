-- Private table exports. A job pages rows out of Database under the creator's
-- live authority and stores them as parts in private object storage. Progress
-- is checkpointed per part, so a job interrupted at any point resumes where it
-- stopped. A download is a single-use, short-lived token; only its hash is kept.
CREATE TABLE data_export_jobs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  table_id uuid NOT NULL,
  command_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES accounts(id),
  -- The session the job acts for. Its authority is resolved again at every claim; nothing here grants access by itself.
  authority_actor jsonb NOT NULL CHECK (jsonb_typeof(authority_actor) = 'object'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('jsonl', 'csv')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'ready', 'failed', 'cancelled', 'expired')),
  cancellation_requested boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  row_count bigint NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  byte_count bigint NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  part_count integer NOT NULL DEFAULT 0 CHECK (part_count >= 0),
  -- The checkpoint: the last row already stored, and the table revision every part was read at.
  after_row_id uuid,
  table_revision bigint CHECK (table_revision IS NULL OR table_revision > 0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  lease_id uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT now() + interval '6 hours',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  FOREIGN KEY (binding_id, environment_id, project_id, org_id) REFERENCES service_bindings(id, environment_id, project_id, org_id),
  UNIQUE (actor_id, command_id),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state IN ('ready', 'failed', 'cancelled', 'expired')) = (completed_at IS NOT NULL)),
  CHECK (state IN ('queued', 'running') OR lease_id IS NULL),
  CHECK ((state IN ('ready', 'expired')) = (expires_at IS NOT NULL))
);
CREATE INDEX data_export_jobs_work_idx ON data_export_jobs (next_attempt_at, created_at, id) WHERE state IN ('queued', 'running');
CREATE INDEX data_export_jobs_scope_idx ON data_export_jobs (org_id, project_id, environment_id, created_at DESC, id);
CREATE INDEX data_export_jobs_expiry_idx ON data_export_jobs (expires_at) WHERE state = 'ready';

-- One stored object per part. A row exists only after its object was written; it is removed only after its object was deleted.
CREATE TABLE data_export_parts (
  job_id uuid NOT NULL REFERENCES data_export_jobs(id),
  number integer NOT NULL CHECK (number > 0),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 512),
  row_count integer NOT NULL CHECK (row_count >= 0),
  byte_count bigint NOT NULL CHECK (byte_count > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, number)
);

CREATE TABLE data_export_downloads (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  job_id uuid NOT NULL REFERENCES data_export_jobs(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_export_downloads_job_idx ON data_export_downloads (job_id);

CREATE TABLE data_export_commands (
  actor_id uuid NOT NULL REFERENCES accounts(id),
  command_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES data_export_jobs(id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, command_id)
);

CREATE TABLE data_export_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES data_export_jobs(id),
  -- Null when Cloud's own worker acted.
  actor_account_id uuid REFERENCES accounts(id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION record_data_export_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform_events (id, source, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, revision, request_id, occurred_at)
    VALUES (NEW.id, TG_TABLE_NAME, NEW.org_id, NEW.project_id, NEW.environment_id, CASE WHEN NEW.actor_account_id IS NULL THEN 'system' ELSE 'account' END, NEW.actor_account_id,
      NEW.action, 'data_export', NEW.job_id, NEW.revision, NEW.request_id, NEW.created_at);
  RETURN NULL;
END;
$$;
CREATE TRIGGER platform_event AFTER INSERT ON data_export_events FOR EACH ROW EXECUTE FUNCTION record_data_export_event();
