-- carbon-registry's own schema: plugin metadata and version records.
--
-- No organizations/api_tokens here: identity is owned by carbon-cloud
-- alone (real SSO, see HttpIdentityClient) — this product is a client of
-- that over HTTP, not a second copy of the same data.
--
-- Tarball BYTES live in S3-compatible object storage (MinIO in dev, key
-- `${name}/${version}.tar.zst`) — this is catalog/metadata only, same
-- split as carbon-database's storage_buckets/storage_files vs. its S3
-- bucket.

CREATE TABLE IF NOT EXISTS plugins (
  name            text PRIMARY KEY,
  category        text NOT NULL,
  description     text NOT NULL,
  author_org_id   text NOT NULL,
  author_name     text NOT NULL,
  latest_version  text NOT NULL,
  downloads       bigint NOT NULL DEFAULT 0,
  verified        boolean NOT NULL DEFAULT false,
  tags            jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plugins_category_idx ON plugins (category);

CREATE TABLE IF NOT EXISTS plugin_versions (
  plugin_name      text NOT NULL REFERENCES plugins (name) ON DELETE CASCADE,
  version          text NOT NULL,
  readme           text NOT NULL DEFAULT '',
  checksum_sha256  text NOT NULL,
  object_key       text NOT NULL,
  size_bytes       bigint NOT NULL,
  platforms        jsonb NOT NULL DEFAULT '[]',
  abi_version      text NOT NULL DEFAULT 'v1.0',
  permissions      jsonb NOT NULL DEFAULT '[]',
  published_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_name, version)
);
CREATE INDEX IF NOT EXISTS plugin_versions_plugin_idx ON plugin_versions (plugin_name);
