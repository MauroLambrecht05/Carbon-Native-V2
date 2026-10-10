-- Enrolled workers. A worker belongs to one organization and is created by a
-- one-time we_ enrollment code. Its wc_ credential, like every other
-- credential here, is stored as a hash and a display prefix only.
CREATE TABLE workers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  purposes text[] NOT NULL CHECK (cardinality(purposes) BETWEEN 1 AND 2 AND purposes <@ ARRAY['build','function']),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled','revoked')),
  capabilities jsonb CHECK (capabilities IS NULL OR jsonb_typeof(capabilities) = 'object'),
  enrollment_hash text UNIQUE CHECK (enrollment_hash IS NULL OR enrollment_hash ~ '^[a-f0-9]{64}$'),
  enrollment_expires_at timestamptz,
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  token_prefix text CHECK (token_prefix IS NULL OR token_prefix ~ '^wc_[A-Za-z0-9_-]{8}$'),
  credential_expires_at timestamptz,
  last_seen_at timestamptz,
  created_by uuid NOT NULL REFERENCES accounts(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (enrollment_hash IS NOT NULL)),
  CHECK (status IN ('active','disabled') OR token_hash IS NULL),
  CHECK ((token_hash IS NULL) = (credential_expires_at IS NULL))
);
CREATE INDEX workers_org_idx ON workers(org_id, id);
CREATE UNIQUE INDEX workers_name_idx ON workers(org_id, name) WHERE status <> 'revoked';

CREATE TABLE worker_commands (
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  scope_key text NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_account_id,scope_key,key_digest)
);

-- A lease is the only thing that lets a worker read secrets: one subject
-- (a build or function execution), one environment, a named list of secrets,
-- one worker, a bounded lifetime. A lost lease is never reused; a successor
-- row with the next attempt number replaces it.
CREATE TABLE worker_leases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('build','function')),
  subject_id uuid NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  secret_names text[] NOT NULL CHECK (cardinality(secret_names) <= 50),
  required_platform text CHECK (required_platform IS NULL OR required_platform IN ('windows','linux','macos')),
  worker_id uuid REFERENCES workers(id),
  state text NOT NULL DEFAULT 'granted' CHECK (state IN ('granted','claimed','completed','cancelled','expired')),
  lease_token_hash text UNIQUE CHECK (lease_token_hash IS NULL OR lease_token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  materialized_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at <= deadline_at),
  CHECK (state = 'granted' OR worker_id IS NOT NULL OR state IN ('cancelled','expired')),
  CHECK (state = 'claimed' OR lease_token_hash IS NULL),
  UNIQUE (subject_id, attempt),
  FOREIGN KEY (environment_id, project_id, org_id) REFERENCES environments(id, project_id, org_id)
);
CREATE INDEX worker_leases_queue_idx ON worker_leases(org_id, purpose, created_at) WHERE state = 'granted';
CREATE INDEX worker_leases_worker_idx ON worker_leases(worker_id, state);

CREATE TABLE worker_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  worker_id uuid REFERENCES workers(id),
  lease_id uuid REFERENCES worker_leases(id),
  account_id uuid REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('worker.enrollment_created','worker.enrolled','worker.credential_rotated','worker.disabled','worker.enabled','worker.revoked',
    'lease.granted','lease.claimed','lease.secrets_materialized','lease.completed','lease.cancelled','lease.expired')),
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
