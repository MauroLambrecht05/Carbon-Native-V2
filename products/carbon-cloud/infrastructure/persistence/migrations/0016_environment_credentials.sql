CREATE TABLE environment_credentials (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND name !~ '[[:cntrl:]]'),
  token_prefix text NOT NULL CHECK (token_prefix ~ '^ce_[A-Za-z0-9_-]{8}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  audience text NOT NULL DEFAULT 'automation' CHECK (audience = 'automation'),
  permissions jsonb NOT NULL CHECK (
    jsonb_typeof(permissions) = 'array'
    AND jsonb_array_length(permissions) BETWEEN 1 AND 5
    AND permissions <@ '["metadata.read", "resources.configure", "data.read", "data.write", "release.publish"]'::jsonb
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id),
  UNIQUE (environment_id, name),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX environment_credentials_scope_idx ON environment_credentials(org_id, project_id, environment_id, id);

CREATE TABLE environment_credential_overlaps (
  credential_id uuid NOT NULL REFERENCES environment_credentials(id),
  token_prefix text NOT NULL CHECK (token_prefix ~ '^ce_[A-Za-z0-9_-]{8}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, token_hash)
);
CREATE INDEX environment_credential_overlaps_expiry_idx ON environment_credential_overlaps(valid_until);

CREATE TABLE environment_credential_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('create', 'rotate', 'revoke')),
  credential_id uuid NOT NULL REFERENCES environment_credentials(id),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_account_id, scope_key, key_digest)
);

CREATE TABLE environment_credential_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  credential_id uuid NOT NULL REFERENCES environment_credentials(id),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('credential.created', 'credential.rotated', 'credential.revoked')),
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
