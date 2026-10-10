-- Application authentication: one realm per environment, for an app's own
-- end users. Distinct from accounts (the developers) and from the legacy
-- organization-wide end_users of 0004, which are left untouched.
CREATE TABLE realms (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  signup_enabled boolean NOT NULL DEFAULT false,
  magic_link_enabled boolean NOT NULL DEFAULT true,
  session_ttl_seconds integer NOT NULL DEFAULT 86400 CHECK (session_ttl_seconds BETWEEN 300 AND 2592000),
  redirect_allowlist text[] NOT NULL DEFAULT '{}' CHECK (cardinality(redirect_allowlist) <= 20),
  -- Sessions and assertions carry the revision they were issued under; raising it ends them all.
  claims_revision bigint NOT NULL DEFAULT 1 CHECK (claims_revision > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, environment_id, project_id, org_id),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);

-- An OIDC provider. The client secret is not stored here: it is an environment secret, referenced by name.
CREATE TABLE realm_providers (
  id uuid PRIMARY KEY,
  realm_id uuid NOT NULL REFERENCES realms(id),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,39}$'),
  issuer text NOT NULL CHECK (issuer ~ '^https://' AND char_length(issuer) <= 2048),
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255),
  client_secret_name text CHECK (client_secret_name IS NULL OR client_secret_name ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm_id, name)
);

CREATE TABLE app_users (
  id uuid PRIMARY KEY,
  realm_id uuid NOT NULL REFERENCES realms(id),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'deleted')),
  last_signed_in_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, realm_id)
);
-- A deleted user's address can sign up again as a new user.
CREATE UNIQUE INDEX app_users_email_idx ON app_users (realm_id, email) WHERE state <> 'deleted';

CREATE TABLE app_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  realm_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^(email|[a-z][a-z0-9-]{1,39})$'),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  verified_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, realm_id) REFERENCES app_users(id, realm_id),
  UNIQUE (realm_id, provider, subject, user_id)
);
CREATE INDEX app_identities_lookup_idx ON app_identities (realm_id, provider, subject);

-- A magic link (token_hash) or an OIDC authorization in flight (state_hash). Single use.
CREATE TABLE app_challenges (
  id uuid PRIMARY KEY,
  realm_id uuid NOT NULL REFERENCES realms(id),
  kind text NOT NULL CHECK (kind IN ('magic_link', 'oidc')),
  email text,
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  state_hash text UNIQUE CHECK (state_hash IS NULL OR state_hash ~ '^[a-f0-9]{64}$'),
  provider_name text,
  protected_flow text,
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) <= 2048),
  claims_revision bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'magic_link') = (token_hash IS NOT NULL AND email IS NOT NULL)),
  CHECK ((kind = 'oidc') = (state_hash IS NOT NULL AND provider_name IS NOT NULL AND protected_flow IS NOT NULL))
);

CREATE TABLE app_email_outbox (
  id uuid PRIMARY KEY REFERENCES app_challenges(id),
  protected_message text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'delivered', 'expired')),
  attempt integer NOT NULL DEFAULT 0,
  ready_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_email_outbox_ready_idx ON app_email_outbox (ready_at) WHERE state IN ('pending', 'sending');

CREATE TABLE app_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  realm_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  claims_revision bigint NOT NULL CHECK (claims_revision > 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, realm_id) REFERENCES app_users(id, realm_id)
);
CREATE INDEX app_sessions_user_idx ON app_sessions (user_id) WHERE revoked_at IS NULL;

-- Keyed digests only: no address or email is stored for rate limiting.
CREATE TABLE app_auth_rate_limits (
  realm_id uuid NOT NULL REFERENCES realms(id),
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (realm_id, key_digest, window_started_at)
);

CREATE TABLE realm_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_account_id, scope_key, key_digest)
);

CREATE TABLE app_auth_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  realm_id uuid NOT NULL REFERENCES realms(id),
  user_id uuid,
  actor_account_id uuid REFERENCES accounts(id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- App authentication events join the organization log (see 0023). An app user's own action has a system actor
-- there: the log's actors are developer accounts and workers, and the resource names the user.
CREATE FUNCTION record_app_auth_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform_events (id, source, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, request_id, occurred_at)
    VALUES (NEW.id, TG_TABLE_NAME, NEW.org_id, NEW.project_id, NEW.environment_id, CASE WHEN NEW.actor_account_id IS NULL THEN 'system' ELSE 'account' END, NEW.actor_account_id,
      NEW.action, CASE WHEN NEW.user_id IS NULL THEN 'realm' ELSE 'app_user' END, COALESCE(NEW.user_id, NEW.realm_id), NEW.request_id, NEW.created_at);
  RETURN NULL;
END;
$$;
CREATE TRIGGER platform_event AFTER INSERT ON app_auth_events FOR EACH ROW EXECUTE FUNCTION record_app_auth_event();
