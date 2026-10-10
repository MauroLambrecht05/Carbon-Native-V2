CREATE TABLE projects (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{2,39}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deletion_pending', 'deleted')),
  production_mutations_allowed boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, slug)
);
CREATE TABLE environments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('development', 'staging', 'production')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'deletion_pending', 'deleted')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id),
  UNIQUE (id, project_id, org_id)
);
CREATE UNIQUE INDEX environments_project_name_idx ON environments (project_id, lower(name));

ALTER TABLE memberships ADD COLUMN project_access text NOT NULL DEFAULT 'role' CHECK (project_access IN ('role', 'all', 'assigned'));
ALTER TABLE memberships ADD CONSTRAINT memberships_id_org_key UNIQUE (id, org_id);
CREATE TABLE project_assignments (
  membership_id uuid NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, project_id),
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships(id, org_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id)
);
CREATE TABLE membership_grants (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid,
  environment_id uuid,
  permission text NOT NULL CHECK (permission IN ('organization.manage', 'members.manage', 'projects.create', 'metadata.read', 'resources.configure', 'data.read', 'data.write', 'release.publish', 'build.cancel.any', 'signing.manage', 'billing.manage', 'audit.read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships(id, org_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id),
  CHECK (environment_id IS NULL OR project_id IS NOT NULL)
);
CREATE UNIQUE INDEX membership_grants_org_idx ON membership_grants (membership_id, permission) WHERE project_id IS NULL;
CREATE UNIQUE INDEX membership_grants_project_idx ON membership_grants (membership_id, permission, project_id) WHERE project_id IS NOT NULL AND environment_id IS NULL;
CREATE UNIQUE INDEX membership_grants_environment_idx ON membership_grants (membership_id, permission, environment_id) WHERE environment_id IS NOT NULL;

CREATE TABLE catalog_commands (
  account_id uuid NOT NULL REFERENCES accounts(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, scope_key, key_digest)
);
CREATE TABLE catalog_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid,
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
CREATE INDEX catalog_events_outbox_idx ON catalog_events (sequence) WHERE published_at IS NULL;
