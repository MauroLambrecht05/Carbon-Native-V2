-- One ordered, organization-scoped log over the per-capability event tables.
-- Rows are written by triggers in the same transaction as the source event, so
-- the log can neither miss a committed event nor record an aborted one.
--
-- Readers order by (transaction_id, sequence) and read only below the oldest
-- running transaction. An identity sequence alone is not a safe cursor: a
-- transaction that took a lower number can commit after a higher one was read.
CREATE TABLE platform_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  id uuid NOT NULL UNIQUE,
  source text NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid,
  environment_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('account', 'worker', 'system')),
  actor_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  resource_kind text NOT NULL CHECK (char_length(resource_kind) BETWEEN 1 AND 100),
  resource_id uuid NOT NULL,
  revision bigint CHECK (revision IS NULL OR revision > 0),
  request_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_kind = 'system') = (actor_id IS NULL)),
  CHECK (project_id IS NOT NULL OR environment_id IS NULL)
);
CREATE INDEX platform_events_org_idx ON platform_events (org_id, transaction_id, sequence);
CREATE INDEX platform_events_project_idx ON platform_events (project_id, transaction_id, sequence) WHERE project_id IS NOT NULL;

CREATE FUNCTION record_platform_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid; v_project uuid; v_environment uuid; v_actor uuid; v_actor_kind text := 'account';
  v_kind text; v_resource uuid; v_revision bigint; v_request uuid;
BEGIN
  IF TG_TABLE_NAME = 'organization_security_events' THEN
    v_org := NEW.org_id; v_actor := NEW.actor_account_id; v_kind := 'organization'; v_resource := NEW.org_id; v_revision := NEW.revision; v_request := NEW.request_id;
  ELSIF TG_TABLE_NAME = 'catalog_events' THEN
    v_org := NEW.org_id; v_project := NEW.project_id; v_environment := NEW.environment_id; v_actor := NEW.actor_account_id; v_revision := NEW.revision; v_request := NEW.request_id;
    IF NEW.environment_id IS NULL THEN v_kind := 'project'; v_resource := NEW.project_id; ELSE v_kind := 'environment'; v_resource := NEW.environment_id; END IF;
  ELSIF TG_TABLE_NAME = 'environment_credential_events' THEN
    v_org := NEW.org_id; v_project := NEW.project_id; v_environment := NEW.environment_id; v_actor := NEW.actor_account_id;
    v_kind := 'environment_credential'; v_resource := NEW.credential_id; v_revision := NEW.revision; v_request := NEW.request_id;
  ELSIF TG_TABLE_NAME = 'environment_secret_events' THEN
    v_org := NEW.org_id; v_project := NEW.project_id; v_environment := NEW.environment_id; v_actor := NEW.actor_account_id;
    v_kind := 'environment_secret'; v_resource := NEW.secret_id; v_revision := NEW.revision; v_request := NEW.request_id;
  ELSIF TG_TABLE_NAME = 'repository_events' THEN
    v_org := NEW.org_id; v_project := NEW.project_id; v_actor := NEW.actor_account_id; v_revision := NEW.revision; v_request := NEW.request_id;
    IF NEW.repository_id IS NOT NULL THEN v_kind := 'repository'; v_resource := NEW.repository_id;
    ELSIF NEW.installation_id IS NOT NULL THEN v_kind := 'repository_installation'; v_resource := NEW.installation_id;
    ELSE v_kind := 'organization'; v_resource := NEW.org_id; END IF;
  ELSIF TG_TABLE_NAME = 'service_account_events' THEN
    v_org := NEW.org_id; v_project := NEW.project_id; v_environment := NEW.environment_id; v_actor := NEW.actor_account_id;
    v_kind := 'service_account'; v_resource := NEW.service_account_id; v_revision := NEW.revision; v_request := NEW.request_id;
  ELSIF TG_TABLE_NAME = 'device_authorization_events' THEN
    SELECT org_id, project_id, environment_id INTO v_org, v_project, v_environment FROM device_authorizations WHERE id = NEW.authorization_id;
    v_actor := NEW.account_id; v_request := NEW.request_id;
    IF NEW.credential_id IS NULL THEN v_kind := 'device_authorization'; v_resource := NEW.authorization_id; ELSE v_kind := 'device_grant'; v_resource := NEW.credential_id; END IF;
  ELSIF TG_TABLE_NAME = 'personal_credential_events' THEN
    SELECT org_id, project_id, environment_id INTO v_org, v_project, v_environment FROM personal_credentials WHERE id = NEW.credential_id;
    v_actor := NEW.account_id; v_kind := 'personal_credential'; v_resource := NEW.credential_id; v_request := NEW.request_id;
  ELSIF TG_TABLE_NAME = 'legacy_token_events' THEN
    v_org := NEW.org_id; v_actor := NEW.account_id; v_request := NEW.request_id;
    IF NEW.token_id IS NULL THEN v_kind := 'organization'; v_resource := NEW.org_id; ELSE v_kind := 'legacy_token'; v_resource := NEW.token_id; END IF;
  ELSIF TG_TABLE_NAME = 'worker_events' THEN
    v_org := NEW.org_id; v_request := NEW.request_id;
    IF NEW.lease_id IS NOT NULL THEN
      SELECT project_id, environment_id INTO v_project, v_environment FROM worker_leases WHERE id = NEW.lease_id;
      v_kind := 'worker_lease'; v_resource := NEW.lease_id;
    ELSE v_kind := 'worker'; v_resource := NEW.worker_id; END IF;
    IF NEW.account_id IS NOT NULL THEN v_actor := NEW.account_id;
    ELSIF NEW.worker_id IS NOT NULL THEN v_actor := NEW.worker_id; v_actor_kind := 'worker'; END IF;
  ELSIF TG_TABLE_NAME = 'data_import_job_events' THEN
    SELECT org_id, project_id, environment_id, request_id INTO v_org, v_project, v_environment, v_request FROM data_import_jobs WHERE id = NEW.operation_id;
    v_kind := 'data_import'; v_resource := NEW.operation_id;
  END IF;
  IF v_actor IS NULL THEN v_actor_kind := 'system'; END IF;
  -- A source row without an organization or resource (never expected) is skipped instead of failing the business write.
  IF v_org IS NULL OR v_resource IS NULL OR v_request IS NULL OR NEW.action !~ '^[a-z][a-z0-9_.-]{0,99}$' THEN RETURN NULL; END IF;
  INSERT INTO platform_events (id, source, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, revision, request_id, occurred_at)
    VALUES (NEW.id, TG_TABLE_NAME, v_org, v_project, v_environment, v_actor_kind, v_actor, NEW.action, v_kind, v_resource, v_revision, v_request, NEW.created_at);
  RETURN NULL;
END;
$$;

CREATE TRIGGER platform_event AFTER INSERT ON organization_security_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON catalog_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON environment_credential_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON environment_secret_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON repository_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON service_account_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON device_authorization_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON personal_credential_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON legacy_token_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON worker_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();
CREATE TRIGGER platform_event AFTER INSERT ON data_import_job_events FOR EACH ROW EXECUTE FUNCTION record_platform_event();

-- Deletion is a scheduled, recoverable state before it is final.
ALTER TABLE projects ADD COLUMN deletion_scheduled_at timestamptz;
ALTER TABLE projects ADD COLUMN deletion_requested_by uuid REFERENCES accounts(id);
ALTER TABLE projects ADD CONSTRAINT projects_deletion_schedule CHECK ((state = 'deletion_pending') = (deletion_scheduled_at IS NOT NULL));
ALTER TABLE environments ADD COLUMN deletion_scheduled_at timestamptz;
ALTER TABLE environments ADD COLUMN deletion_requested_by uuid REFERENCES accounts(id);
ALTER TABLE environments ADD CONSTRAINT environments_deletion_schedule CHECK ((state = 'deletion_pending') = (deletion_scheduled_at IS NOT NULL));
ALTER TABLE organizations ADD COLUMN deletion_requested_by uuid REFERENCES accounts(id);
ALTER TABLE organizations ADD COLUMN suspension_reason text CHECK (suspension_reason IS NULL OR suspension_reason ~ '^[a-z][a-z0-9_.-]{0,99}$');
