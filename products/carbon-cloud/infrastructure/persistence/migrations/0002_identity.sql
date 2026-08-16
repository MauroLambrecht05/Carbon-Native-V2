-- Organizations and API tokens. See @carbon/identity — self-hosted v1's
-- whole model: an org owns everything, a token authenticates as one, as
-- either of two scopes (see ApiToken.ts's TokenScope for what each can do).

CREATE TABLE IF NOT EXISTS organizations (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  scope       text NOT NULL CHECK (scope IN ('org', 'worker')),
  -- SHA-256 of the token — see domain/value-objects/TokenHash.ts for why
  -- not bcrypt/argon2. Looked up on every authenticated request, so this
  -- needs an index, not just a primary key elsewhere.
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_tokens_hash_idx ON api_tokens (token_hash);

-- builds.org_id stays a free-text column, not a foreign key: 0001_init.sql
-- predates organizations existing at all, and the application layer already
-- only ever writes an org_id it got from a verified token (see
-- infrastructure/http/routes.ts's auth middleware). Adding the FK later,
-- once a real migration tool tracks applied versions, is the honest way to
-- tighten this — not a same-file ALTER TABLE this repo can't test live.
