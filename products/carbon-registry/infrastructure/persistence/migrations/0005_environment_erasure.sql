-- An environment can be erased: Cloud's final deletion, carried out here.
--
-- The environment's row stays, marked `erased`, so the identity is never reused and the record of what was done
-- to it keeps its foreign keys. Everything it owned is removed in the same transaction that writes the receipt.

ALTER TABLE platform_environments DROP CONSTRAINT platform_environments_state_check;
ALTER TABLE platform_environments ADD CONSTRAINT platform_environments_state_check CHECK (state IN ('active', 'paused', 'erased'));

CREATE TABLE platform_erasures (
  erasure_id uuid PRIMARY KEY,
  -- One erasure per environment, ever.
  environment_id uuid NOT NULL UNIQUE REFERENCES platform_environments(environment_id),
  binding_id uuid NOT NULL,
  remote_resource_id uuid NOT NULL,
  -- What is returned to Cloud, now and for every later delivery of the same erasure.
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION protect_platform_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'platform_erasures' THEN
    RAISE EXCEPTION 'An erasure is a permanent record' USING ERRCODE = '23514', CONSTRAINT = 'platform_erasure_permanent';
  END IF;
  -- An erased environment never becomes anything else.
  IF OLD.state = 'erased' THEN
    RAISE EXCEPTION 'An erased environment cannot change' USING ERRCODE = '23514', CONSTRAINT = 'platform_environment_erased';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_erasure_guard BEFORE UPDATE OR DELETE ON platform_erasures FOR EACH ROW EXECUTE FUNCTION protect_platform_erasure();
CREATE TRIGGER platform_environment_erased_guard BEFORE UPDATE OR DELETE ON platform_environments FOR EACH ROW EXECUTE FUNCTION protect_platform_erasure();

-- Registry's namespace for an environment is removed when the environment is erased, so the two-state check on
-- the namespace table is unchanged.
