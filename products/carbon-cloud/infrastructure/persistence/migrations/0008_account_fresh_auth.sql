ALTER TABLE account_challenges ADD COLUMN bound_session_id uuid REFERENCES account_sessions(id);
ALTER TABLE account_challenges ADD COLUMN bound_security_revision bigint CHECK (bound_security_revision > 0);
-- Old, unbound fresh_auth rows were never issued by the platform API. They
-- cannot authenticate and must not prevent the forward-only schema upgrade.
UPDATE account_challenges SET consumed_at = COALESCE(consumed_at, now()) WHERE purpose = 'fresh_auth';
ALTER TABLE account_challenges ADD CONSTRAINT account_challenges_fresh_binding CHECK (
  (purpose = 'fresh_auth' AND ((bound_session_id IS NOT NULL AND bound_security_revision IS NOT NULL) OR consumed_at IS NOT NULL))
  OR (purpose <> 'fresh_auth' AND bound_session_id IS NULL AND bound_security_revision IS NULL)
);
CREATE INDEX account_challenges_bound_session_idx ON account_challenges (bound_session_id) WHERE consumed_at IS NULL;
