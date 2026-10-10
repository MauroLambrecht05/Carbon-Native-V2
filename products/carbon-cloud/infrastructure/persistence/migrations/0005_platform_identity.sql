-- Add human identity without inventing owners for existing organizations.
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  primary_email text NOT NULL UNIQUE,
  name text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'deleted')),
  verified_at timestamptz NOT NULL,
  terms_version text NOT NULL,
  security_revision bigint NOT NULL DEFAULT 1 CHECK (security_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_identities (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  provider text NOT NULL CHECK (provider IN ('email', 'github')),
  provider_subject text NOT NULL,
  verified_at timestamptz NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE TABLE account_challenges (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('registration', 'login', 'recovery', 'fresh_auth')),
  token_hash text NOT NULL UNIQUE,
  terms_version text NOT NULL,
  redirect_path text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_challenges_expiry_idx ON account_challenges (expires_at);

CREATE TABLE account_sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  device_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  mfa_verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_sessions_account_idx ON account_sessions (account_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('totp')),
  encrypted_secret_reference text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'active', 'disabled')),
  last_counter bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  code_hash text NOT NULL UNIQUE,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organizations ADD COLUMN slug text;
ALTER TABLE organizations ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'deletion_pending', 'deleted'));
ALTER TABLE organizations ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE organizations ADD COLUMN owner_policy jsonb NOT NULL DEFAULT '{"requireMfa":false}';
ALTER TABLE organizations ADD COLUMN deletion_scheduled_at timestamptz;
CREATE UNIQUE INDEX organizations_slug_idx ON organizations (slug) WHERE slug IS NOT NULL;

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  role text NOT NULL CHECK (role IN ('Owner', 'Admin', 'Developer', 'Viewer', 'Billing')),
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, org_id)
);
CREATE INDEX memberships_org_idx ON memberships (org_id, state);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('Admin', 'Developer', 'Viewer', 'Billing')),
  assignments jsonb NOT NULL DEFAULT '[]',
  token_hash text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('pending', 'accepted', 'cancelled', 'superseded')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  invited_by uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending_email_idx ON invitations (org_id, email) WHERE state = 'pending';

CREATE TABLE service_accounts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  permission_revision bigint NOT NULL DEFAULT 1 CHECK (permission_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_credentials (
  id uuid PRIMARY KEY,
  service_account_id uuid NOT NULL REFERENCES service_accounts(id),
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  grants jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- This is an inbox for sensitive account events, without customer payloads.
-- The account event and identity change are committed in the same transaction.
CREATE TABLE account_security_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES accounts(id),
  session_id uuid,
  action text NOT NULL,
  request_id uuid NOT NULL,
  security_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX account_security_events_outbox_idx ON account_security_events (sequence) WHERE published_at IS NULL;

-- Each receiving service owns an equivalent replay table; no in-memory replay cache.
CREATE TABLE internal_assertion_replays (
  issuer text NOT NULL,
  audience text NOT NULL,
  jti uuid NOT NULL,
  retain_until timestamptz NOT NULL,
  PRIMARY KEY (issuer, audience, jti)
);
CREATE INDEX internal_assertion_replays_expiry_idx ON internal_assertion_replays (retain_until);
