-- Usage metering and plan assignment. See @carbon/billing.

CREATE TABLE IF NOT EXISTS usage_records (
  id            uuid PRIMARY KEY,
  org_id        text NOT NULL,
  build_id      uuid NOT NULL,
  duration_ms   bigint NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- sumMinutesForOrg filters on org_id + recorded_at every time a build is
-- created (CheckUsageLimitUseCase) — same reasoning as builds_queued_idx.
CREATE INDEX IF NOT EXISTS usage_records_org_period_idx ON usage_records (org_id, recorded_at);

CREATE TABLE IF NOT EXISTS org_plans (
  org_id  text PRIMARY KEY,
  plan    text NOT NULL
);
