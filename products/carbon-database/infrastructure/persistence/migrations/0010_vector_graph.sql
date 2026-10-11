-- Canonical vector collections and the canonical graph, scoped to an
-- environment. The legacy vector_collections / vector_points / graph_nodes /
-- graph_edges tables of 0001 are untouched.
CREATE TABLE canonical_vector_collections (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,62}$'),
  dimension integer NOT NULL CHECK (dimension BETWEEN 1 AND 2000),
  metric text NOT NULL CHECK (metric IN ('cosine', 'l2', 'inner')),
  point_count bigint NOT NULL DEFAULT 0 CHECK (point_count >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, name),
  FOREIGN KEY (resource_id, org_id, project_id, environment_id) REFERENCES platform_environments(id, org_id, project_id, environment_id)
);
CREATE TABLE canonical_vector_points (
  collection_id uuid NOT NULL REFERENCES canonical_vector_collections(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  embedding vector NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, id)
);
CREATE INDEX canonical_vector_points_metadata_idx ON canonical_vector_points USING gin (metadata jsonb_path_ops);

CREATE TABLE canonical_graph_nodes (
  environment_id uuid NOT NULL REFERENCES platform_environments(environment_id),
  id uuid NOT NULL,
  label text NOT NULL CHECK (label ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  properties jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(properties) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, id)
);
-- Both ends of an edge are nodes of the same environment, enforced by the database: an edge cannot dangle or cross environments.
CREATE TABLE canonical_graph_edges (
  environment_id uuid NOT NULL,
  id uuid NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  label text NOT NULL CHECK (label ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  properties jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(properties) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, id),
  FOREIGN KEY (environment_id, source_id) REFERENCES canonical_graph_nodes(environment_id, id),
  FOREIGN KEY (environment_id, target_id) REFERENCES canonical_graph_nodes(environment_id, id)
);
CREATE INDEX canonical_graph_edges_out_idx ON canonical_graph_edges (environment_id, source_id, label, target_id);
CREATE INDEX canonical_graph_edges_in_idx ON canonical_graph_edges (environment_id, target_id, label, source_id);

-- Receipts for vector and graph commands, so a retried command returns what it returned the first time.
CREATE TABLE engine_commands (
  family text NOT NULL CHECK (family IN ('vectors', 'graph')),
  principal_kind text NOT NULL CHECK (principal_kind IN ('account', 'service_account')),
  principal_id uuid NOT NULL,
  command_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family, principal_kind, principal_id, command_id)
);
