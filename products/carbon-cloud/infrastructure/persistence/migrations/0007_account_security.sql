ALTER TABLE accounts ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE accounts ADD COLUMN mfa_failed_attempts integer NOT NULL DEFAULT 0 CHECK (mfa_failed_attempts >= 0);
ALTER TABLE accounts ADD COLUMN mfa_locked_until timestamptz;
ALTER TABLE mfa_factors ADD COLUMN expires_at timestamptz;
CREATE UNIQUE INDEX mfa_factors_current_account_idx ON mfa_factors (account_id) WHERE state IN ('pending', 'active');

CREATE TABLE account_security_commands (
  account_id uuid NOT NULL REFERENCES accounts(id),
  session_id uuid NOT NULL REFERENCES account_sessions(id),
  key_digest text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, session_id, key_digest)
);
