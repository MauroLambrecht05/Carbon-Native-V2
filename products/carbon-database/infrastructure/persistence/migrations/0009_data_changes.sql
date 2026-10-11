-- The change feed for canonical tables. A trigger on every native table writes
-- one row here in the same transaction as the change itself, whatever made the
-- change: the data API, an import, or SQL run by an operator. Readers follow it
-- in commit order.
CREATE TABLE data_change_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Commit order across transactions is (transaction_id, sequence), read only below the oldest transaction still running.
  transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  environment_id uuid NOT NULL,
  table_id uuid NOT NULL REFERENCES canonical_data_tables(id),
  row_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  row_revision bigint CHECK (row_revision IS NULL OR row_revision > 0),
  -- Who could see the row when this happened, by the table's policies at that moment:
  -- {"public": bool, "owners": [text]}. An update lists the owners before and after it.
  visibility jsonb NOT NULL CHECK (jsonb_typeof(visibility) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((operation = 'delete') = (row_revision IS NULL))
);
CREATE INDEX data_change_events_feed_idx ON data_change_events (table_id, transaction_id, sequence);
CREATE INDEX data_change_events_age_idx ON data_change_events (occurred_at);

-- How far each table's feed has been pruned. A reader whose cursor is at or before this has missed events.
CREATE TABLE data_change_pruned (
  table_id uuid PRIMARY KEY REFERENCES canonical_data_tables(id),
  transaction_id xid8 NOT NULL,
  sequence bigint NOT NULL,
  pruned_at timestamptz NOT NULL DEFAULT now()
);

-- Runs as its owner so the environment's restricted role, which makes the change, cannot write or read the feed itself.
CREATE FUNCTION carbon_capture_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_table uuid := TG_ARGV[0]::uuid;
  v_definition jsonb; v_environment uuid; v_old jsonb; v_new jsonb; v_owners text[] := ARRAY[]::text[]; v_public boolean := false; v_rule jsonb; v_value text;
BEGIN
  SELECT definition, environment_id INTO v_definition, v_environment FROM public.canonical_data_tables WHERE id = v_table;
  IF v_definition IS NULL THEN RAISE EXCEPTION 'Change capture found no catalog entry for this table'; END IF;
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  -- With policies off nobody reads the table through the data API, so nobody is told about its changes either.
  IF COALESCE((v_definition->'policies'->>'enabled')::boolean, false) THEN
    FOR v_rule IN SELECT value FROM jsonb_array_elements(v_definition->'policies'->'rules') LOOP
      IF NOT (v_rule->'operations') ? 'select' THEN CONTINUE; END IF;
      IF v_rule->>'kind' = 'public-read' THEN v_public := true;
      ELSIF v_rule->>'kind' = 'owner' THEN
        FOREACH v_value IN ARRAY ARRAY[v_old->>(v_rule->>'ownerColumn'), v_new->>(v_rule->>'ownerColumn')] LOOP
          IF v_value IS NOT NULL AND NOT v_value = ANY(v_owners) THEN v_owners := v_owners || v_value; END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;
  INSERT INTO public.data_change_events (environment_id, table_id, row_id, operation, row_revision, visibility)
    VALUES (v_environment, v_table, COALESCE(v_new->>'_carbon_id', v_old->>'_carbon_id')::uuid, lower(TG_OP), (v_new->>'_carbon_revision')::bigint,
      jsonb_build_object('public', v_public, 'owners', to_jsonb(v_owners)));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION carbon_capture_change() FROM PUBLIC;

-- Tables that already exist start being captured now. New tables get the trigger when they are created.
DO $$
DECLARE v_row record; v_target text;
BEGIN
  FOR v_row IN SELECT id, environment_id FROM canonical_data_tables LOOP
    v_target := format('%I.%I', 'ce_' || replace(v_row.environment_id::text, '-', ''), 'ct_' || replace(v_row.id::text, '-', ''));
    IF to_regclass(v_target) IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER carbon_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION public.carbon_capture_change(%L)', v_target, v_row.id);
    END IF;
  END LOOP;
END;
$$;
