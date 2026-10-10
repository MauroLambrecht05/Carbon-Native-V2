CREATE TABLE device_authorizations (
  id uuid PRIMARY KEY,
  device_code_hash text NOT NULL UNIQUE CHECK (device_code_hash ~ '^[a-f0-9]{64}$'),
  user_code_hash text NOT NULL UNIQUE CHECK (user_code_hash ~ '^[a-f0-9]{64}$'),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 200),
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid,
  environment_id uuid,
  permissions text[] NOT NULL CHECK (cardinality(permissions) BETWEEN 1 AND 5),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','consumed')),
  approved_by uuid REFERENCES accounts(id),
  credential_id uuid,
  interval_seconds integer NOT NULL DEFAULT 5 CHECK (interval_seconds BETWEEN 5 AND 60),
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (project_id IS NOT NULL OR environment_id IS NULL),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);

CREATE TABLE device_grants (
  id uuid PRIMARY KEY,
  authorization_id uuid NOT NULL UNIQUE REFERENCES device_authorizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid,
  environment_id uuid,
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 200),
  permissions text[] NOT NULL CHECK (cardinality(permissions) BETWEEN 1 AND 5),
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  token_prefix text CHECK (token_prefix IS NULL OR token_prefix ~ '^dc_[A-Za-z0-9_-]{8}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  permission_revision bigint NOT NULL CHECK (permission_revision > 0),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (project_id IS NOT NULL OR environment_id IS NULL),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
ALTER TABLE device_authorizations ADD CONSTRAINT device_authorizations_credential_fk FOREIGN KEY (credential_id) REFERENCES device_grants(id);
CREATE INDEX device_grants_account_idx ON device_grants(account_id,id);

CREATE TABLE device_authorization_rate_limits (
  peer_digest text NOT NULL CHECK (peer_digest ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (peer_digest, window_started_at)
);

CREATE TABLE device_grant_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_account_id,scope_key,key_digest)
);

CREATE TABLE device_authorization_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  authorization_id uuid NOT NULL REFERENCES device_authorizations(id),
  credential_id uuid REFERENCES device_grants(id),
  account_id uuid REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('device.requested','device.approved','device.denied','device.token_issued','device.revoked')),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
