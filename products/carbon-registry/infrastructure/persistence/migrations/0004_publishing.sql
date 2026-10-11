-- Publishing under canonical environment authority. A publisher name belongs
-- to one organization. A version is submitted, uploaded into quarantine,
-- reviewed by an operator, and only then published with a signed statement.
-- The legacy plugins and plugin_versions tables are left as they are.
CREATE TABLE registry_publishers (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
  org_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended')),
  claimed_by jsonb NOT NULL CHECK (jsonb_typeof(claimed_by) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registry_publishers_org_idx ON registry_publishers (org_id);

CREATE TABLE registry_packages (
  id uuid PRIMARY KEY,
  publisher_id uuid NOT NULL REFERENCES registry_publishers(id),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,48}[a-z0-9]$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publisher_id, name)
);

CREATE TABLE registry_versions (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES registry_packages(id),
  -- Where the submission came from. Ownership is the publisher's organization, not this environment.
  environment_id uuid NOT NULL REFERENCES platform_environments(environment_id),
  version text NOT NULL CHECK (length(version) <= 64),
  target text NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_upload' CHECK (state IN ('awaiting_upload', 'submitted', 'rejected', 'published', 'revoked')),
  yanked boolean NOT NULL DEFAULT false,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  upload_token_hash text UNIQUE CHECK (upload_token_hash IS NULL OR upload_token_hash ~ '^[a-f0-9]{64}$'),
  upload_expires_at timestamptz,
  object_key text,
  statement jsonb,
  key_id text,
  signature text,
  submitted_by jsonb NOT NULL CHECK (jsonb_typeof(submitted_by) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK ((state = 'awaiting_upload') = (upload_token_hash IS NOT NULL)),
  CHECK ((state IN ('published', 'revoked')) = (statement IS NOT NULL AND key_id IS NOT NULL AND signature IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (state NOT IN ('submitted', 'published', 'revoked') OR object_key IS NOT NULL),
  CHECK (NOT yanked OR state = 'published')
);
-- One live claim on a version number per target. A rejected submission frees the number; a published or revoked one never does.
CREATE UNIQUE INDEX registry_versions_identity_idx ON registry_versions (package_id, version, target) WHERE state <> 'rejected';
CREATE INDEX registry_versions_package_idx ON registry_versions (package_id, created_at DESC);
CREATE INDEX registry_versions_review_idx ON registry_versions (created_at) WHERE state = 'submitted';

CREATE FUNCTION protect_registry_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A registry version is never deleted' USING ERRCODE = '23514', CONSTRAINT = 'registry_version_kept';
  END IF;
  -- What was submitted is what is reviewed and published: its identity and bytes never change.
  IF NEW.package_id IS DISTINCT FROM OLD.package_id OR NEW.version IS DISTINCT FROM OLD.version OR NEW.target IS DISTINCT FROM OLD.target OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest OR NEW.environment_id IS DISTINCT FROM OLD.environment_id THEN
    RAISE EXCEPTION 'A submitted version cannot be changed' USING ERRCODE = '23514', CONSTRAINT = 'registry_version_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'awaiting_upload' AND NEW.state IN ('submitted', 'rejected')) OR (OLD.state = 'submitted' AND NEW.state IN ('published', 'rejected')) OR (OLD.state = 'published' AND NEW.state = 'revoked')) THEN
    RAISE EXCEPTION 'This version cannot move to that state' USING ERRCODE = '23514', CONSTRAINT = 'registry_version_transition';
  END IF;
  -- Once published, the signed statement and the stored archive are fixed for good.
  IF OLD.state IN ('published', 'revoked') AND (NEW.statement IS DISTINCT FROM OLD.statement OR NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.signature IS DISTINCT FROM OLD.signature
    OR NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'A published version is immutable' USING ERRCODE = '23514', CONSTRAINT = 'registry_version_published';
  END IF;
  IF OLD.state IN ('rejected', 'revoked') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'A closed version cannot change' USING ERRCODE = '23514', CONSTRAINT = 'registry_version_closed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER registry_version_guard BEFORE UPDATE OR DELETE ON registry_versions FOR EACH ROW EXECUTE FUNCTION protect_registry_version();

-- What a reviewer decided, on what evidence. Append-only.
CREATE TABLE registry_review_records (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES registry_versions(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'revoked')),
  operator text NOT NULL CHECK (operator ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_registry_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A review record is permanent' USING ERRCODE = '23514', CONSTRAINT = 'registry_review_permanent';
END;
$$;
CREATE TRIGGER registry_review_guard BEFORE UPDATE OR DELETE ON registry_review_records FOR EACH ROW EXECUTE FUNCTION protect_registry_review();

CREATE TABLE registry_commands (
  environment_id uuid NOT NULL REFERENCES platform_environments(environment_id),
  command_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, command_id)
);

CREATE TABLE registry_package_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL,
  publisher_id uuid NOT NULL REFERENCES registry_publishers(id),
  version_id uuid REFERENCES registry_versions(id),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
