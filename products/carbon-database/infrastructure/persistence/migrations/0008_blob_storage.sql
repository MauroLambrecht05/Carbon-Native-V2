-- Canonical blob storage. Bytes live in private object storage under opaque
-- keys; everything that decides who may touch them lives here. The legacy
-- storage_buckets / storage_files tables of 0001 are untouched.
CREATE TABLE blob_buckets (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,62}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting')),
  -- Bytes of every stored version, current or not, until it is purged.
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  object_count bigint NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, project_id, environment_id),
  FOREIGN KEY (resource_id, org_id, project_id, environment_id) REFERENCES platform_environments(id, org_id, project_id, environment_id)
);
-- A name is free again once its bucket is being deleted.
CREATE UNIQUE INDEX blob_buckets_name_idx ON blob_buckets (environment_id, name) WHERE state = 'active';
CREATE INDEX blob_buckets_scope_idx ON blob_buckets (org_id, project_id, environment_id, name);

-- One row per stored version. The row's id is the version id.
CREATE TABLE blob_objects (
  id uuid PRIMARY KEY,
  bucket_id uuid NOT NULL REFERENCES blob_buckets(id),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 512),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 3 AND 127),
  -- Where the bytes are. Never derived from the key, so a key cannot be used to guess or address another object.
  storage_key text NOT NULL UNIQUE CHECK (char_length(storage_key) BETWEEN 1 AND 512),
  state text NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'replaced', 'deleted')),
  created_by jsonb NOT NULL CHECK (jsonb_typeof(created_by) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  -- When cleanup may delete the bytes and this row. Null while the version is current.
  purge_after timestamptz,
  CHECK ((state = 'current') = (removed_at IS NULL)),
  CHECK ((state = 'current') = (purge_after IS NULL))
);
CREATE UNIQUE INDEX blob_objects_current_idx ON blob_objects (bucket_id, key) WHERE state = 'current';
CREATE INDEX blob_objects_versions_idx ON blob_objects (bucket_id, key, created_at DESC, id);
CREATE INDEX blob_objects_purge_idx ON blob_objects (purge_after) WHERE state <> 'current';

-- Single-use upload and download addresses. Only the token's hash is stored.
CREATE TABLE blob_transfers (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  id uuid NOT NULL UNIQUE,
  bucket_id uuid NOT NULL REFERENCES blob_buckets(id),
  kind text NOT NULL CHECK (kind IN ('upload', 'download')),
  key text NOT NULL,
  -- For a download: the version to serve. For an upload: the version this transfer will create.
  object_id uuid NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL,
  storage_key text NOT NULL,
  principal jsonb NOT NULL CHECK (jsonb_typeof(principal) = 'object'),
  request_id uuid NOT NULL,
  -- issued: not used yet. receiving: the one use has begun. completed / failed / expired: over.
  state text NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'receiving', 'completed', 'failed', 'expired')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'issued') = (used_at IS NULL) OR state = 'expired'),
  CHECK ((state IN ('completed', 'failed', 'expired')) = (finished_at IS NOT NULL))
);
-- Quota counts uploads that may still land.
CREATE INDEX blob_transfers_reserved_idx ON blob_transfers (bucket_id) WHERE kind = 'upload' AND state IN ('issued', 'receiving');
CREATE INDEX blob_transfers_open_idx ON blob_transfers (expires_at) WHERE state IN ('issued', 'receiving');

CREATE TABLE blob_commands (
  principal_kind text NOT NULL CHECK (principal_kind IN ('account', 'service_account')),
  principal_id uuid NOT NULL,
  command_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_kind, principal_id, command_id)
);

CREATE TABLE blob_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  bucket_id uuid NOT NULL REFERENCES blob_buckets(id),
  -- Null when the service's own cleanup acted, or for a public download.
  actor jsonb CHECK (actor IS NULL OR jsonb_typeof(actor) = 'object'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  request_id uuid NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Metering. One row per thing that happened once: `source_id` is the transfer or version it was measured from, so
-- a retried or repeated report cannot count twice.
CREATE TABLE blob_usage (
  id uuid PRIMARY KEY,
  bucket_id uuid NOT NULL REFERENCES blob_buckets(id),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('stored', 'removed', 'egress')),
  bytes bigint NOT NULL CHECK (bytes > 0),
  source_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, source_id)
);
CREATE INDEX blob_usage_scope_idx ON blob_usage (org_id, environment_id, recorded_at);
