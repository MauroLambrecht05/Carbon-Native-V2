ALTER TABLE accounts ADD COLUMN avatar text NOT NULL DEFAULT '' CHECK (char_length(avatar) <= 8);

CREATE TABLE account_email_changes (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  session_id uuid NOT NULL REFERENCES account_sessions(id),
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  previous_email text NOT NULL,
  proposed_email text NOT NULL,
  browser_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('pending', 'verified', 'cancelled', 'superseded')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX account_email_changes_pending_idx ON account_email_changes (account_id) WHERE state = 'pending';

-- The same durable worker now delivers authentication, address verification
-- and security notices. Preserve a typed owner reference for every job.
ALTER TABLE account_email_outbox DROP CONSTRAINT account_email_outbox_id_fkey;
ALTER TABLE account_email_outbox ADD COLUMN email_change_id uuid REFERENCES account_email_changes(id);
ALTER TABLE account_email_outbox ADD COLUMN account_id uuid REFERENCES accounts(id);
-- Existing authentication writers still insert only id/message/expiry. Derive
-- their challenge owner while keeping notices and email changes distinct.
ALTER TABLE account_email_outbox ADD COLUMN challenge_id uuid GENERATED ALWAYS AS (
  CASE WHEN email_change_id IS NULL AND account_id IS NULL THEN id ELSE NULL END
) STORED REFERENCES account_challenges(id);
ALTER TABLE account_email_outbox ADD CONSTRAINT account_email_outbox_owner CHECK (
  num_nonnulls(challenge_id, email_change_id, account_id) = 1
);
