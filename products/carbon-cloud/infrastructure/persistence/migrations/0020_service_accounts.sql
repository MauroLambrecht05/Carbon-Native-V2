-- 0005 reserved skeletal service-account/token tables before canonical scopes
-- existed. Keep those rows explicitly legacy and add the managed v2 shape
-- without interpreting broad historical grants.
ALTER TABLE service_accounts ADD COLUMN managed boolean NOT NULL DEFAULT false;
ALTER TABLE service_accounts ADD COLUMN project_id uuid;
ALTER TABLE service_accounts ADD COLUMN environment_id uuid;
ALTER TABLE service_accounts ADD COLUMN permissions text[];
ALTER TABLE service_accounts ADD COLUMN audience text;
ALTER TABLE service_accounts ADD COLUMN status text;
ALTER TABLE service_accounts ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE service_accounts ADD COLUMN created_by uuid REFERENCES accounts(id);
ALTER TABLE service_accounts ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE service_accounts ADD CONSTRAINT service_accounts_managed_shape CHECK (
  NOT managed OR (project_id IS NOT NULL AND permissions IS NOT NULL AND cardinality(permissions) BETWEEN 1 AND 5 AND audience = 'automation' AND status IN ('active','disabled') AND created_by IS NOT NULL)
);
ALTER TABLE service_accounts ADD CONSTRAINT service_accounts_project_fk FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id);
ALTER TABLE service_accounts ADD CONSTRAINT service_accounts_environment_fk FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id);
CREATE UNIQUE INDEX service_accounts_managed_name_idx ON service_accounts(org_id,name) WHERE managed;
CREATE INDEX service_accounts_scope_idx ON service_accounts(org_id, project_id, environment_id, id);

CREATE TABLE service_account_credentials (
  id uuid PRIMARY KEY,
  service_account_id uuid NOT NULL REFERENCES service_accounts(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  token_prefix text NOT NULL CHECK (token_prefix ~ '^cs_[A-Za-z0-9_-]{8}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  service_account_permission_revision bigint NOT NULL CHECK (service_account_permission_revision > 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_account_id, name),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX service_account_credentials_account_idx ON service_account_credentials(service_account_id, id);

CREATE TABLE service_account_credential_overlaps (
  credential_id uuid NOT NULL REFERENCES service_account_credentials(id),
  token_prefix text NOT NULL CHECK (token_prefix ~ '^cs_[A-Za-z0-9_-]{8}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  service_account_permission_revision bigint NOT NULL CHECK (service_account_permission_revision > 0),
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, token_hash)
);
CREATE INDEX service_account_credential_overlaps_expiry_idx ON service_account_credential_overlaps(valid_until);

CREATE TABLE service_account_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('create','update','disable','enable','credential.create','credential.rotate','credential.revoke')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_account_id, scope_key, key_digest)
);

CREATE TABLE service_account_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid,
  service_account_id uuid NOT NULL REFERENCES service_accounts(id),
  credential_id uuid REFERENCES service_account_credentials(id),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('service_account.created','service_account.updated','service_account.disabled','service_account.enabled','service_account.credential_created','service_account.credential_rotated','service_account.credential_revoked')),
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
