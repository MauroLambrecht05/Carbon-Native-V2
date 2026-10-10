-- Personal credentials: account-owned pt_ tokens for one exact scope.
-- Only the SHA-256 hash and a display prefix are stored. Revocation clears the hash.
CREATE TABLE personal_credentials (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid,
  environment_id uuid,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  permissions text[] NOT NULL CHECK (cardinality(permissions) BETWEEN 1 AND 5),
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  token_prefix text NOT NULL CHECK (token_prefix ~ '^pt_[A-Za-z0-9_-]{8}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  permission_revision bigint NOT NULL CHECK (permission_revision > 0),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (project_id IS NOT NULL OR environment_id IS NULL),
  CHECK ((status = 'revoked') = (token_hash IS NULL)),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
CREATE INDEX personal_credentials_account_idx ON personal_credentials(account_id, id);
CREATE UNIQUE INDEX personal_credentials_name_idx ON personal_credentials(account_id, name) WHERE status = 'active';

CREATE TABLE personal_credential_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_account_id,scope_key,key_digest)
);

CREATE TABLE personal_credential_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  credential_id uuid NOT NULL REFERENCES personal_credentials(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('personal.created','personal.rotated','personal.revoked')),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Legacy cc_/wk_ tokens (0002). Additive only: existing rows stay accepted
-- and keep their hash. Retirement is a reversible status, not a deletion, so
-- the deprecation stages can be rolled back.
ALTER TABLE api_tokens ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired'));
ALTER TABLE api_tokens ADD COLUMN last_used_at timestamptz;
ALTER TABLE api_tokens ADD COLUMN retired_at timestamptz;
ALTER TABLE api_tokens ADD COLUMN retired_by uuid REFERENCES accounts(id);
ALTER TABLE api_tokens ADD COLUMN replaced_by_service_account uuid REFERENCES service_accounts(id);
ALTER TABLE api_tokens ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_retirement CHECK ((status = 'retired') = (retired_at IS NOT NULL));
CREATE INDEX api_tokens_org_idx ON api_tokens(org_id, id);

CREATE TABLE legacy_token_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_account_id,scope_key,key_digest)
);

CREATE TABLE legacy_token_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  token_id uuid REFERENCES api_tokens(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('legacy.claimed','legacy.retired','legacy.restored')),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
