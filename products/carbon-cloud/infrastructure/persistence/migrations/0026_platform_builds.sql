-- Build orchestration on worker leases. The legacy `builds` table of 0001 and
-- its wk_ queue are untouched; these are the canonical, environment-scoped builds.
CREATE TABLE platform_builds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- The immutable input: exactly what will be built. Fixed at creation.
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 10),
  created_by uuid NOT NULL REFERENCES accounts(id),
  reserved_minutes integer NOT NULL CHECK (reserved_minutes BETWEEN 1 AND 1440),
  used_minutes integer CHECK (used_minutes IS NULL OR used_minutes BETWEEN 0 AND 1440),
  error_category text CHECK (error_category IS NULL OR error_category ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  deadline_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  -- A finished build has settled its quota, and only a finished build has.
  CHECK ((state IN ('succeeded', 'failed', 'cancelled')) = (completed_at IS NOT NULL AND used_minutes IS NOT NULL)),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
CREATE INDEX platform_builds_scope_idx ON platform_builds (org_id, project_id, environment_id, id);
CREATE INDEX platform_builds_open_idx ON platform_builds (deadline_at) WHERE state IN ('queued', 'running');
-- Minutes held against the organization's quota until the build finishes.
CREATE INDEX platform_builds_reserved_idx ON platform_builds (org_id) WHERE state IN ('queued', 'running');

CREATE FUNCTION protect_platform_build() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source OR NEW.source_digest IS DISTINCT FROM OLD.source_digest OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.environment_id IS DISTINCT FROM OLD.environment_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A build input is immutable' USING ERRCODE = '23514', CONSTRAINT = 'platform_build_immutable_input';
  END IF;
  -- Terminal states never move.
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'A finished build cannot change state' USING ERRCODE = '23514', CONSTRAINT = 'platform_build_terminal_state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_build_guard BEFORE UPDATE ON platform_builds FOR EACH ROW EXECUTE FUNCTION protect_platform_build();

-- One attempt per worker lease. A lost lease's attempt is marked lost; its successor lease starts the next attempt.
CREATE TABLE build_attempts (
  id uuid PRIMARY KEY,
  build_id uuid NOT NULL REFERENCES platform_builds(id),
  number integer NOT NULL CHECK (number BETWEEN 1 AND 10),
  lease_id uuid NOT NULL UNIQUE REFERENCES worker_leases(id),
  worker_id uuid NOT NULL REFERENCES workers(id),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed', 'lost', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK ((state = 'running') = (ended_at IS NULL)),
  UNIQUE (build_id, number)
);

-- Append-only log, gapless per build across attempts.
CREATE TABLE build_log_segments (
  build_id uuid NOT NULL REFERENCES platform_builds(id),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 100000),
  attempt_id uuid NOT NULL REFERENCES build_attempts(id),
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 262144),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (build_id, sequence)
);

-- Declared outputs. Each belongs to the attempt that produced it and never changes.
CREATE TABLE build_artifacts (
  id uuid PRIMARY KEY,
  build_id uuid NOT NULL REFERENCES platform_builds(id),
  attempt_id uuid NOT NULL REFERENCES build_attempts(id),
  target text NOT NULL CHECK (target ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- Postgres caps a regex repetition count at 255, so the length is checked separately.
  object_key text NOT NULL CHECK (object_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' AND char_length(object_key) <= 512 AND object_key !~ '\.\.'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, target)
);

CREATE FUNCTION forbid_build_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Build logs and artifacts are append-only' USING ERRCODE = '23514', CONSTRAINT = 'build_record_append_only';
END;
$$;
CREATE TRIGGER build_log_append_only BEFORE UPDATE OR DELETE ON build_log_segments FOR EACH ROW EXECUTE FUNCTION forbid_build_record_change();
CREATE TRIGGER build_artifact_append_only BEFORE UPDATE OR DELETE ON build_artifacts FOR EACH ROW EXECUTE FUNCTION forbid_build_record_change();

CREATE TABLE build_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_account_id, scope_key, key_digest)
);

CREATE TABLE build_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  build_id uuid NOT NULL REFERENCES platform_builds(id),
  actor_account_id uuid REFERENCES accounts(id),
  worker_id uuid REFERENCES workers(id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION record_build_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform_events (id, source, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, revision, request_id, occurred_at)
    VALUES (NEW.id, TG_TABLE_NAME, NEW.org_id, NEW.project_id, NEW.environment_id,
      CASE WHEN NEW.actor_account_id IS NOT NULL THEN 'account' WHEN NEW.worker_id IS NOT NULL THEN 'worker' ELSE 'system' END, COALESCE(NEW.actor_account_id, NEW.worker_id),
      NEW.action, 'build', NEW.build_id, NEW.revision, NEW.request_id, NEW.created_at);
  RETURN NULL;
END;
$$;
CREATE TRIGGER platform_event AFTER INSERT ON build_events FOR EACH ROW EXECUTE FUNCTION record_build_event();
