CREATE TABLE platform_environments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL UNIQUE,
  binding_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('active', 'paused')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, project_id, environment_id)
);
CREATE TABLE platform_lifecycle_commands (
  step_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  environment_id uuid NOT NULL REFERENCES platform_environments(environment_id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_security_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  environment_id uuid NOT NULL REFERENCES platform_environments(environment_id),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  action text NOT NULL,
  step_id uuid NOT NULL REFERENCES platform_lifecycle_commands(step_id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE internal_assertion_replays (
  issuer text NOT NULL,
  audience text NOT NULL,
  jti uuid NOT NULL,
  retain_until timestamptz NOT NULL,
  PRIMARY KEY (issuer, audience, jti)
);
CREATE INDEX internal_assertion_replays_expiry_idx ON internal_assertion_replays (retain_until);
CREATE TABLE registry_environment_namespaces (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('active', 'paused')),
  FOREIGN KEY (id, org_id, project_id, environment_id) REFERENCES platform_environments(id, org_id, project_id, environment_id)
);
