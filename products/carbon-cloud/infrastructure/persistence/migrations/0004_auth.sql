-- End-user (magic-link) identity — @carbon/auth. Distinct from
-- organizations/api_tokens (0002_identity.sql): those are the app
-- DEVELOPER'S account, these are an app's OWN customers.

CREATE TABLE IF NOT EXISTS end_users (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id            uuid PRIMARY KEY,
  end_user_id   uuid NOT NULL REFERENCES end_users(id),
  -- SHA-256 of the token, same reasoning as api_tokens.token_hash.
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS magic_link_tokens_hash_idx ON magic_link_tokens (token_hash);

CREATE TABLE IF NOT EXISTS end_user_sessions (
  id             uuid PRIMARY KEY,
  end_user_id    uuid NOT NULL REFERENCES end_users(id),
  -- Denormalized off end_users.org_id rather than joined on every
  -- session check: this is read on every authenticated end-user request,
  -- the same reason api_tokens keeps its own org_id instead of joining
  -- through a token->something else chain.
  org_id         uuid NOT NULL REFERENCES organizations(id),
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS end_user_sessions_hash_idx ON end_user_sessions (token_hash);
