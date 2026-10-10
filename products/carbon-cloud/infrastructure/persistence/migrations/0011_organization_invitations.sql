ALTER TABLE invitations ADD COLUMN accepted_by uuid REFERENCES accounts(id);
ALTER TABLE invitations ADD COLUMN inviter_membership_id uuid REFERENCES memberships(id);
ALTER TABLE invitations ADD COLUMN inviter_membership_revision bigint CHECK (inviter_membership_revision > 0);
-- Unbound historical proofs must not acquire authority from a later membership.
UPDATE invitations SET state = 'superseded', revision = revision + 1 WHERE state = 'pending';
ALTER TABLE invitations ADD CONSTRAINT invitations_pending_authority CHECK (
  state <> 'pending' OR (inviter_membership_id IS NOT NULL AND inviter_membership_revision IS NOT NULL)
);
ALTER TABLE organization_security_events ADD COLUMN invitation_id uuid REFERENCES invitations(id);

-- Preserve queued authentication/email-change/notice jobs and their old writers.
ALTER TABLE account_email_outbox DROP CONSTRAINT account_email_outbox_owner;
ALTER TABLE account_email_outbox DROP COLUMN challenge_id;
ALTER TABLE account_email_outbox ADD COLUMN invitation_id uuid REFERENCES invitations(id);
ALTER TABLE account_email_outbox ADD COLUMN challenge_id uuid GENERATED ALWAYS AS (
  CASE WHEN email_change_id IS NULL AND account_id IS NULL AND invitation_id IS NULL THEN id ELSE NULL END
) STORED REFERENCES account_challenges(id);
ALTER TABLE account_email_outbox ADD CONSTRAINT account_email_outbox_owner CHECK (
  num_nonnulls(challenge_id, email_change_id, account_id, invitation_id) = 1
);
CREATE INDEX account_email_outbox_invitation_idx ON account_email_outbox (invitation_id) WHERE invitation_id IS NOT NULL;
