CREATE UNIQUE INDEX account_identities_github_account_idx ON account_identities (account_id) WHERE provider = 'github';

CREATE TABLE account_external_flows (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'github'),
  purpose text NOT NULL CHECK (purpose IN ('login', 'registration', 'link')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'exchanging', 'ready', 'consumed', 'failed', 'expired')),
  state_hash text NOT NULL UNIQUE,
  browser_hash text NOT NULL,
  protected_start text,
  protected_identity text,
  completion_hash text UNIQUE,
  request_key text NOT NULL UNIQUE,
  request_digest text NOT NULL,
  request_id uuid NOT NULL,
  terms_version text NOT NULL,
  redirect_path text NOT NULL,
  bound_account_id uuid REFERENCES accounts(id),
  bound_session_id uuid REFERENCES account_sessions(id),
  bound_security_revision bigint,
  resolved_account_id uuid REFERENCES accounts(id),
  resolved_security_revision bigint,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((purpose = 'link' AND bound_account_id IS NOT NULL AND bound_session_id IS NOT NULL AND bound_security_revision IS NOT NULL)
    OR (purpose <> 'link' AND num_nonnulls(bound_account_id, bound_session_id, bound_security_revision) = 0)),
  CHECK ((resolved_account_id IS NULL) = (resolved_security_revision IS NULL)),
  CHECK ((state = 'pending' AND protected_start IS NOT NULL AND protected_identity IS NULL AND completion_hash IS NULL)
    OR (state = 'exchanging' AND protected_start IS NULL AND protected_identity IS NULL AND completion_hash IS NULL)
    OR (state = 'ready' AND protected_start IS NULL AND protected_identity IS NOT NULL AND completion_hash IS NOT NULL)
    OR (state IN ('consumed', 'failed', 'expired') AND protected_start IS NULL AND protected_identity IS NULL))
);
CREATE INDEX account_external_flows_expiry_idx ON account_external_flows (expires_at) WHERE state IN ('pending', 'exchanging', 'ready');
