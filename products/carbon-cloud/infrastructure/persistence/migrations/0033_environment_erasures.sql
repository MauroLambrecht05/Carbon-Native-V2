-- Final deletion reaches the owning services.
--
-- When an environment's deletion becomes final, whether on its own, with its project, or with its organization,
-- one erasure is recorded for each owning service that holds a resource for it. A worker delivers each as a signed
-- request; the owning service asks Cloud whether exactly that erasure is on record before it destroys anything.

CREATE TABLE environment_erasures (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  -- One erasure per binding, ever: a resource is destroyed once.
  binding_id uuid NOT NULL UNIQUE REFERENCES service_bindings(id),
  owner text NOT NULL CHECK (owner IN ('database', 'registry')),
  remote_resource_id text NOT NULL CHECK (char_length(remote_resource_id) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'erased')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Why the last delivery did not finish. A category, never the owning service's own words.
  last_error text CHECK (last_error IS NULL OR last_error ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  -- Also the claim: a worker that takes an erasure moves this forward, so another does not deliver it at the same time.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- What the owning service said it removed.
  receipt jsonb,
  CHECK ((state = 'erased') = (completed_at IS NOT NULL)),
  CHECK ((state = 'erased') = (receipt IS NOT NULL)),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
CREATE INDEX environment_erasures_due_idx ON environment_erasures (next_attempt_at) WHERE state = 'pending';
CREATE INDEX environment_erasures_org_idx ON environment_erasures (org_id);

-- Recorded by the database itself, so no code path that makes a deletion final can forget it.
CREATE FUNCTION record_environment_erasures() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'deleted' OR OLD.state = 'deleted' THEN RETURN NEW; END IF;
  INSERT INTO environment_erasures (id, org_id, project_id, environment_id, binding_id, owner, remote_resource_id)
    SELECT gen_random_uuid(), b.org_id, b.project_id, b.environment_id, b.id, b.owner, b.remote_resource_id
    FROM service_bindings b
    WHERE b.remote_resource_id IS NOT NULL
      AND CASE TG_TABLE_NAME WHEN 'environments' THEN b.environment_id = NEW.id WHEN 'projects' THEN b.project_id = NEW.id ELSE b.org_id = NEW.id END
    ON CONFLICT (binding_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER environment_erasure_record AFTER UPDATE OF state ON environments FOR EACH ROW EXECUTE FUNCTION record_environment_erasures();
CREATE TRIGGER project_erasure_record AFTER UPDATE OF state ON projects FOR EACH ROW EXECUTE FUNCTION record_environment_erasures();
CREATE TRIGGER organization_erasure_record AFTER UPDATE OF state ON organizations FOR EACH ROW EXECUTE FUNCTION record_environment_erasures();

-- What an erasure is for never changes, it is never removed, and a completed one never changes at all.
CREATE FUNCTION protect_environment_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An erasure is a permanent record' USING ERRCODE = '23514', CONSTRAINT = 'environment_erasure_permanent';
  END IF;
  IF OLD.state = 'erased' THEN
    RAISE EXCEPTION 'A completed erasure cannot change' USING ERRCODE = '23514', CONSTRAINT = 'environment_erasure_final';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
    OR NEW.binding_id IS DISTINCT FROM OLD.binding_id OR NEW.owner IS DISTINCT FROM OLD.owner OR NEW.remote_resource_id IS DISTINCT FROM OLD.remote_resource_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'An erasure is bound to one resource' USING ERRCODE = '23514', CONSTRAINT = 'environment_erasure_bound';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER environment_erasure_guard BEFORE UPDATE OR DELETE ON environment_erasures FOR EACH ROW EXECUTE FUNCTION protect_environment_erasure();
