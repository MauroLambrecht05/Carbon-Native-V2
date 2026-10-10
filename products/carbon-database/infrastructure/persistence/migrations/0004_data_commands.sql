CREATE TABLE canonical_data_commands (
  principal_kind text NOT NULL CHECK (principal_kind IN ('account', 'app_user')),
  principal_id uuid NOT NULL,
  command_id uuid NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  table_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_kind, principal_id, command_id),
  FOREIGN KEY (table_id, org_id, project_id, environment_id) REFERENCES canonical_data_tables(id, org_id, project_id, environment_id)
);
