-- carbon-database's own control-plane schema: everything that ISN'T a
-- developer's own dynamically-created table (those live in a real,
-- per-project Postgres SCHEMA instead — "proj_<id>" — created on demand
-- by DatabaseEngine.createTable, not by this file). This file only holds
-- the catalog/metadata tables the engines need to track what exists.
--
-- No organizations/api_tokens/usage_records/org_plans here: identity and
-- billing are owned by carbon-cloud alone (real SSO, see
-- HttpIdentityClient) — carbon-database is a client of that over HTTP,
-- not a second copy of the same data.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS projects (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects (org_id);

-- Catalog of a project's own dynamically-created tables. `columns` is the
-- ORIGINAL ColumnDefinition[] (name/type/primaryKey/nullable/defaultValue)
-- as JSON — kept verbatim rather than reverse-engineered from Postgres's
-- own information_schema, so the app-level type (e.g. "timestamp") round-
-- trips exactly instead of being re-guessed from whatever real Postgres
-- type it was mapped to.
CREATE TABLE IF NOT EXISTS carbon_tables (
  project_id  text NOT NULL,
  table_name  text NOT NULL,
  columns     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, table_name)
);

CREATE TABLE IF NOT EXISTS project_migrations (
  project_id  text NOT NULL,
  version     integer NOT NULL,
  name        text NOT NULL,
  sql         text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);

CREATE TABLE IF NOT EXISTS vector_collections (
  project_id  text NOT NULL,
  name        text NOT NULL,
  dimension   integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name)
);

-- One shared table for every collection's points rather than one physical
-- table per collection: pgvector's `vector` column type works unconstrained
-- (no fixed dimension at the column-type level) — dimension is enforced at
-- the application layer against vector_collections.dimension, the same
-- check the original in-memory engine already did in JS, now just against
-- real rows instead of a Map.
CREATE TABLE IF NOT EXISTS vector_points (
  project_id       text NOT NULL,
  collection_name  text NOT NULL,
  point_id         text NOT NULL,
  embedding        vector NOT NULL,
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, collection_name, point_id)
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  project_id  text NOT NULL,
  id          text NOT NULL,
  label       text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
  project_id    text NOT NULL,
  id            text NOT NULL,
  source_id     text NOT NULL,
  target_id     text NOT NULL,
  relationship  text NOT NULL,
  weight        double precision NOT NULL DEFAULT 1,
  properties    jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);
-- findShortestPath/getNeighbors load a project's whole graph into memory
-- and run Dijkstra/adjacency lookups in JS (see GraphEngine's own header
-- comment for why that's a legitimate real-world choice at this scale,
-- not a shortcut) — this index is what makes that one bulk load fast.
CREATE INDEX IF NOT EXISTS graph_edges_project_idx ON graph_edges (project_id, source_id);

CREATE TABLE IF NOT EXISTS edge_functions (
  project_id   text NOT NULL,
  name         text NOT NULL,
  code         text NOT NULL,
  env_vars     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  invocations  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, name)
);

CREATE TABLE IF NOT EXISTS storage_buckets (
  project_id  text NOT NULL,
  name        text NOT NULL,
  is_public   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name)
);

-- File BYTES live in S3-compatible object storage (MinIO in dev) — this is
-- catalog/metadata only, so listing doesn't need a round trip to S3's own
-- (eventually-consistent, in general) list API.
CREATE TABLE IF NOT EXISTS storage_files (
  project_id    text NOT NULL,
  bucket        text NOT NULL,
  path          text NOT NULL,
  size_bytes    bigint NOT NULL,
  content_type  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, bucket, path)
);

CREATE TABLE IF NOT EXISTS rls_settings (
  project_id  text NOT NULL,
  table_name  text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (project_id, table_name)
);

-- `rule_expression` is one of a small, known set of canned forms (see
-- RlsPolicyEngine's own header comment) rather than an arbitrary
-- expression language — persisted as text, re-parsed into a real
-- in-process check function on load.
CREATE TABLE IF NOT EXISTS rls_policies (
  id               text PRIMARY KEY,
  project_id       text NOT NULL,
  table_name       text NOT NULL,
  name             text NOT NULL,
  action           text NOT NULL CHECK (action IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL')),
  rule_expression  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rls_policies_table_idx ON rls_policies (project_id, table_name);
