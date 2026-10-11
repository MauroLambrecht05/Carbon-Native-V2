-- Functions: calendar schedules, execution logs, and removal of old inputs, outputs and logs.

-- A schedule is either a fixed interval or a cron expression read in a named time zone, never both.
ALTER TABLE function_schedules ALTER COLUMN interval_seconds DROP NOT NULL;
ALTER TABLE function_schedules
  ADD COLUMN cron text CHECK (cron IS NULL OR (length(cron) BETWEEN 9 AND 100 AND cron ~ '^[0-9*,/ -]+$')),
  ADD COLUMN time_zone text CHECK (time_zone IS NULL OR time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  -- What each scheduled execution is called with.
  ADD COLUMN input jsonb NOT NULL DEFAULT 'null'::jsonb,
  -- The last slot that did not run, and why, so it can be seen without reading the event log.
  ADD COLUMN last_skipped_at timestamptz,
  ADD COLUMN last_skip_reason text CHECK (last_skip_reason IS NULL OR last_skip_reason IN ('overlap', 'function_disabled', 'limit', 'unavailable')),
  ADD CONSTRAINT function_schedules_one_kind CHECK ((interval_seconds IS NOT NULL) <> (cron IS NOT NULL)),
  ADD CONSTRAINT function_schedules_zone_with_cron CHECK ((cron IS NULL) = (time_zone IS NULL)),
  ADD CONSTRAINT function_schedules_skip_together CHECK ((last_skipped_at IS NULL) = (last_skip_reason IS NULL)),
  ADD CONSTRAINT function_schedules_input_size CHECK (pg_column_size(input) <= 70000);

-- What an execution printed, as the worker sent it: already redacted there, bounded, one row per execution.
-- A retry is a new execution with its own row, so the attempt recorded here is the one that reported.
CREATE TABLE function_execution_logs (
  execution_id uuid PRIMARY KEY REFERENCES function_executions(id),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 10),
  body text NOT NULL CHECK (length(body) <= 65536),
  truncated boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE function_executions
  ADD COLUMN has_logs boolean NOT NULL DEFAULT false,
  -- Set when the input, output and logs were removed under the retention rule. The execution itself stays.
  ADD COLUMN pruned_at timestamptz;
CREATE INDEX function_executions_prune_idx ON function_executions (completed_at) WHERE pruned_at IS NULL AND completed_at IS NOT NULL;

-- A finished execution still never changes, with one exception: the retention rule may remove its input, output
-- and logs, once, and must record when. Nothing else about it may differ in that same change.
CREATE OR REPLACE FUNCTION protect_function_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'function_revisions' THEN
    RAISE EXCEPTION 'A function revision is immutable' USING ERRCODE = '23514', CONSTRAINT = 'function_revision_immutable';
  END IF;
  IF TG_TABLE_NAME = 'function_execution_logs' THEN
    RAISE EXCEPTION 'An execution log is written once' USING ERRCODE = '23514', CONSTRAINT = 'function_execution_log_immutable';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'timed_out', 'cancelled') AND OLD.pruned_at IS NULL AND NEW.pruned_at IS NOT NULL
    AND NEW.input = 'null'::jsonb AND NEW.output IS NULL AND NEW.has_logs = false
    AND (to_jsonb(NEW) - 'input' - 'output' - 'has_logs' - 'pruned_at') = (to_jsonb(OLD) - 'input' - 'output' - 'has_logs' - 'pruned_at') THEN
    RETURN NEW;
  END IF;
  -- What an execution runs, and for whom, never changes. A finished execution never changes at all.
  IF NEW.function_id IS DISTINCT FROM OLD.function_id OR NEW.revision_number IS DISTINCT FROM OLD.revision_number OR NEW.code_digest IS DISTINCT FROM OLD.code_digest OR NEW.input IS DISTINCT FROM OLD.input
    OR NEW.environment_id IS DISTINCT FROM OLD.environment_id OR NEW.trigger IS DISTINCT FROM OLD.trigger OR NEW.retry_of IS DISTINCT FROM OLD.retry_of OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id THEN
    RAISE EXCEPTION 'An execution is pinned to what it was created with' USING ERRCODE = '23514', CONSTRAINT = 'function_execution_pinned';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'timed_out', 'cancelled') THEN
    RAISE EXCEPTION 'A finished execution cannot change' USING ERRCODE = '23514', CONSTRAINT = 'function_execution_final';
  END IF;
  -- Only the retention rule sets this, and only on a finished execution.
  IF NEW.pruned_at IS DISTINCT FROM OLD.pruned_at THEN
    RAISE EXCEPTION 'Only a finished execution is pruned' USING ERRCODE = '23514', CONSTRAINT = 'function_execution_prune';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER function_execution_log_guard BEFORE UPDATE ON function_execution_logs FOR EACH ROW EXECUTE FUNCTION protect_function_record();
