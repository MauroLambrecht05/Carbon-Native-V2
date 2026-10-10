ALTER TABLE account_challenges ADD COLUMN browser_hash text;
ALTER TABLE account_challenges ADD COLUMN request_key text;
ALTER TABLE account_challenges ADD COLUMN request_digest text;
ALTER TABLE account_challenges ADD COLUMN request_id uuid;
CREATE UNIQUE INDEX account_challenges_request_key_idx ON account_challenges (request_key) WHERE request_key IS NOT NULL;

CREATE TABLE account_email_outbox (
  id uuid PRIMARY KEY REFERENCES account_challenges(id),
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
CREATE INDEX account_email_outbox_ready_idx ON account_email_outbox (ready_at) WHERE state IN ('pending', 'sending');

CREATE TABLE account_auth_rate_limits (
  key_hash text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  requests integer NOT NULL CHECK (requests > 0)
);
