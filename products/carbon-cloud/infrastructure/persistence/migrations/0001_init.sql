-- The builds table. One row per build; cloud-orchestration's
-- PostgresBuildRepository is the only code that reads or writes it.

CREATE TABLE IF NOT EXISTS builds (
  id            uuid PRIMARY KEY,
  org_id        text NOT NULL,
  repo_url      text NOT NULL,
  commit_sha    text NOT NULL,
  targets       jsonb NOT NULL,
  status        text NOT NULL,
  worker_id     text,
  artifacts     jsonb NOT NULL DEFAULT '[]',
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- claimNext's SELECT filters on status and orders by created_at; without
-- this index that scan gets slower as the table grows exactly when it
-- matters most (many workers polling a busy queue).
CREATE INDEX IF NOT EXISTS builds_queued_idx ON builds (created_at) WHERE status = 'queued';

-- listByOrg's SELECT filters on org_id and orders by created_at — every
-- dashboard load and every `carbon cloud` list call, once one exists.
CREATE INDEX IF NOT EXISTS builds_org_idx ON builds (org_id, created_at DESC);
