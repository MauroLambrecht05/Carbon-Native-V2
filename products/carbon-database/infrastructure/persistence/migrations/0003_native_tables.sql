CREATE TABLE canonical_data_tables (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, name),
  UNIQUE (id, org_id, project_id, environment_id),
  FOREIGN KEY (resource_id, org_id, project_id, environment_id) REFERENCES platform_environments(id, org_id, project_id, environment_id)
);
CREATE TABLE canonical_data_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  table_id uuid NOT NULL REFERENCES canonical_data_tables(id),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  action text NOT NULL,
  request_id uuid NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
