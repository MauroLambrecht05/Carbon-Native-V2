CREATE TABLE environment_secrets (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id),
  UNIQUE (environment_id, name),
  UNIQUE (id, environment_id, project_id, org_id)
);
CREATE INDEX environment_secrets_scope_idx ON environment_secrets(org_id, project_id, environment_id, id);

CREATE TABLE environment_secret_versions (
  id uuid PRIMARY KEY,
  secret_id uuid NOT NULL REFERENCES environment_secrets(id),
  version integer NOT NULL CHECK (version > 0),
  wrapping_key_id text NOT NULL CHECK (wrapping_key_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  envelope text NOT NULL CHECK (char_length(envelope) BETWEEN 1 AND 262144),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (secret_id, version)
);

CREATE TABLE environment_secret_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  secret_id uuid NOT NULL REFERENCES environment_secrets(id),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_account_id, scope_key, key_digest)
);

CREATE TABLE environment_secret_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  secret_id uuid NOT NULL REFERENCES environment_secrets(id),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('secret.created', 'secret.rotated', 'secret.disabled', 'secret.enabled')),
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
