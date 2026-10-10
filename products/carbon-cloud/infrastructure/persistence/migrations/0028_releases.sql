-- Releases and channels. A release is immutable metadata over a succeeded
-- build's verified artifacts. A channel is a pointer whose every movement is an
-- immutable, signed revision. Nothing here stores a private key: a signing
-- profile names an environment secret and records only the public key.
CREATE TABLE signing_profiles (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,31}$'),
  secret_name text NOT NULL CHECK (secret_name ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  -- The Ed25519 public key the secret held when the profile was created; every signature is checked against it.
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, name),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);

-- The public address of an environment's update feed. Random, so it reveals nothing and cannot be guessed.
CREATE TABLE update_feeds (
  environment_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^[a-f0-9]{32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);

CREATE TABLE releases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  build_id uuid NOT NULL REFERENCES platform_builds(id),
  version text NOT NULL CHECK (char_length(version) BETWEEN 5 AND 64),
  notes text NOT NULL CHECK (char_length(notes) <= 4000),
  min_version text CHECK (min_version IS NULL OR char_length(min_version) BETWEEN 5 AND 64),
  signing_profile_id uuid NOT NULL REFERENCES signing_profiles(id),
  state text NOT NULL DEFAULT 'published' CHECK (state IN ('published', 'withdrawn')),
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR char_length(withdrawn_reason) BETWEEN 1 AND 500),
  withdrawn_at timestamptz,
  created_by uuid NOT NULL REFERENCES accounts(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL)),
  -- A version is used once per environment, for good: a withdrawn version is never reissued with other bytes.
  UNIQUE (environment_id, version),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
CREATE INDEX releases_scope_idx ON releases (org_id, project_id, environment_id, id);

CREATE FUNCTION protect_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Withdrawal is the only change a release ever sees, and it happens once.
  IF NEW.build_id IS DISTINCT FROM OLD.build_id OR NEW.version IS DISTINCT FROM OLD.version OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.min_version IS DISTINCT FROM OLD.min_version
    OR NEW.signing_profile_id IS DISTINCT FROM OLD.signing_profile_id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.environment_id IS DISTINCT FROM OLD.environment_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A release is immutable' USING ERRCODE = '23514', CONSTRAINT = 'release_immutable';
  END IF;
  IF OLD.state = 'withdrawn' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'A withdrawn release stays withdrawn' USING ERRCODE = '23514', CONSTRAINT = 'release_withdrawal_final';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_guard BEFORE UPDATE ON releases FOR EACH ROW EXECUTE FUNCTION protect_release();

-- The build artifacts a release offers, one per platform key, with the signature made over the stored bytes.
CREATE TABLE release_artifacts (
  release_id uuid NOT NULL REFERENCES releases(id),
  platform text NOT NULL CHECK (platform ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  target text NOT NULL CHECK (target ~ '^[a-z][a-z0-9-]{1,31}$'),
  object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 512),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9+/]{86}==$'),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  PRIMARY KEY (release_id, platform)
);

CREATE TABLE channels (
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,31}$'),
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, name),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);

-- Every movement of a channel. The manifest text is exactly what is served and exactly what the signature covers.
CREATE TABLE channel_revisions (
  environment_id uuid NOT NULL,
  channel text NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  release_id uuid REFERENCES releases(id),
  rollout integer NOT NULL CHECK (rollout BETWEEN 0 AND 100),
  reason text NOT NULL CHECK (reason IN ('publish', 'rollout', 'withdrawal')),
  manifest text,
  manifest_signature text CHECK (manifest_signature IS NULL OR manifest_signature ~ '^[A-Za-z0-9+/]{86}==$'),
  manifest_digest text CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES accounts(id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, channel, number),
  FOREIGN KEY (environment_id, channel) REFERENCES channels(environment_id, name),
  -- A revision either offers a release with its signed manifest, or offers nothing.
  CHECK ((release_id IS NULL) = (manifest IS NULL) AND (manifest IS NULL) = (manifest_signature IS NULL) AND (manifest IS NULL) = (manifest_digest IS NULL))
);

CREATE FUNCTION forbid_release_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Release artifacts, channel revisions and signing profiles are append-only' USING ERRCODE = '23514', CONSTRAINT = 'release_record_append_only';
END;
$$;
CREATE TRIGGER release_artifact_append_only BEFORE UPDATE OR DELETE ON release_artifacts FOR EACH ROW EXECUTE FUNCTION forbid_release_record_change();
CREATE TRIGGER channel_revision_append_only BEFORE UPDATE OR DELETE ON channel_revisions FOR EACH ROW EXECUTE FUNCTION forbid_release_record_change();
CREATE TRIGGER signing_profile_append_only BEFORE UPDATE OR DELETE ON signing_profiles FOR EACH ROW EXECUTE FUNCTION forbid_release_record_change();

CREATE TABLE release_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_account_id, scope_key, key_digest)
);

CREATE TABLE release_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('release', 'channel', 'signing_profile')),
  -- A release or signing profile id; for a channel, the environment id (the channel name is in the action's detail).
  resource_id uuid NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION record_release_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform_events (id, source, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, revision, request_id, occurred_at)
    VALUES (NEW.id, TG_TABLE_NAME, NEW.org_id, NEW.project_id, NEW.environment_id, 'account', NEW.actor_account_id, NEW.action, NEW.resource_kind, NEW.resource_id, NEW.revision, NEW.request_id, NEW.created_at);
  RETURN NULL;
END;
$$;
CREATE TRIGGER platform_event AFTER INSERT ON release_events FOR EACH ROW EXECUTE FUNCTION record_release_event();
