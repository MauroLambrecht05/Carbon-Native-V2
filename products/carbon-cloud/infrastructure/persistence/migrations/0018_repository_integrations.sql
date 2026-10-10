CREATE TABLE repository_installations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider = 'github'),
  provider_installation_id text NOT NULL UNIQUE CHECK (provider_installation_id ~ '^[1-9][0-9]{0,19}$'),
  provider_account_id text NOT NULL CHECK (provider_account_id ~ '^[1-9][0-9]{0,19}$'),
  account_name text NOT NULL CHECK (account_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  account_kind text NOT NULL CHECK (account_kind IN ('organization', 'user')),
  state text NOT NULL DEFAULT 'connected' CHECK (state IN ('connected', 'suspended')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  validated_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE INDEX repository_installations_org_idx ON repository_installations(org_id, id);

CREATE TABLE repositories (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  org_id uuid NOT NULL,
  provider_repository_id text NOT NULL CHECK (provider_repository_id ~ '^[1-9][0-9]{0,19}$'),
  full_name text NOT NULL CHECK (full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  default_branch text NOT NULL CHECK (char_length(default_branch) BETWEEN 1 AND 255),
  private boolean NOT NULL,
  archived boolean NOT NULL,
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'removed')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  validated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (installation_id, org_id) REFERENCES repository_installations(id, org_id),
  UNIQUE (installation_id, provider_repository_id),
  UNIQUE (id, installation_id, org_id)
);

CREATE TABLE project_repository_configs (
  project_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  branch text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 255),
  root_directory text NOT NULL CHECK (char_length(root_directory) BETWEEN 1 AND 512),
  push_trigger boolean NOT NULL,
  pull_request_trigger boolean NOT NULL,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'disconnected')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id),
  FOREIGN KEY (repository_id, installation_id, org_id) REFERENCES repositories(id, installation_id, org_id)
);

CREATE TABLE repository_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_account_id, scope_key, key_digest)
);

CREATE TABLE repository_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid,
  installation_id uuid,
  repository_id uuid,
  actor_account_id uuid REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('installation.connected', 'installation.refreshed', 'installation.suspended', 'installation.deleted', 'repository.configured', 'repository.cleared', 'repository.commit_resolved', 'repository.proposal_created', 'webhook.accepted')),
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repository_webhook_deliveries (
  delivery_id text PRIMARY KEY CHECK (delivery_id ~ '^[A-Za-z0-9-]{1,100}$'),
  event text NOT NULL CHECK (event ~ '^[a-z][a-z0-9_]{0,63}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  provider_installation_id text NOT NULL CHECK (provider_installation_id ~ '^[1-9][0-9]{0,19}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repository_commit_resolutions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  requested_ref text NOT NULL CHECK (char_length(requested_ref) BETWEEN 1 AND 255),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  repository_revision bigint NOT NULL CHECK (repository_revision > 0),
  resolved_by uuid NOT NULL REFERENCES accounts(id),
  request_id uuid NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id)
);
