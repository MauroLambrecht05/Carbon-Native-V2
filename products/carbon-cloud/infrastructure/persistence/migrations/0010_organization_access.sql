ALTER TABLE accounts ADD COLUMN permission_revision bigint NOT NULL DEFAULT 1 CHECK (permission_revision > 0);
ALTER TABLE organizations ADD COLUMN human_managed boolean NOT NULL DEFAULT false;

CREATE TABLE organization_commands (
  account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL,
  request_digest text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, scope_key, key_digest)
);
CREATE TABLE organization_security_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  subject_account_id uuid REFERENCES accounts(id),
  action text NOT NULL,
  request_id uuid NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX organization_security_events_outbox_idx ON organization_security_events (sequence) WHERE published_at IS NULL;

CREATE TABLE organization_ownership_transfers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  to_account_id uuid NOT NULL REFERENCES accounts(id),
  previous_role text NOT NULL CHECK (previous_role IN ('Admin', 'Developer', 'Viewer', 'Billing')),
  state text NOT NULL CHECK (state IN ('pending', 'accepted', 'cancelled', 'superseded')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  CHECK (from_account_id <> to_account_id)
);
CREATE UNIQUE INDEX organization_ownership_pending_idx ON organization_ownership_transfers (org_id) WHERE state = 'pending';

CREATE FUNCTION require_organization_owner(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE managed boolean; lifecycle text;
BEGIN
  SELECT human_managed, state INTO managed, lifecycle FROM organizations WHERE id = target FOR UPDATE;
  IF managed AND lifecycle <> 'deleted' AND NOT EXISTS (
    SELECT 1 FROM memberships WHERE org_id = target AND state = 'active' AND role = 'Owner'
  ) THEN
    RAISE EXCEPTION 'Organization requires an active owner' USING ERRCODE = '23514', CONSTRAINT = 'organization_active_owner';
  END IF;
END;
$$;
CREATE FUNCTION check_organization_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'organizations' THEN
    PERFORM require_organization_owner(NEW.id);
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM require_organization_owner(OLD.org_id); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM require_organization_owner(NEW.org_id); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER memberships_active_owner AFTER INSERT OR UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_organization_owner();
CREATE CONSTRAINT TRIGGER organizations_active_owner AFTER INSERT OR UPDATE ON organizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_organization_owner();
