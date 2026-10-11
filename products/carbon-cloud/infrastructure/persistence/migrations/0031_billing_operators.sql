-- Billing, metering, operators and legal holds.

-- ── Billing ──────────────────────────────────────────────────────────────────

-- Every provider event Cloud has accepted, once. The primary key is what makes a redelivery a no-op.
CREATE TABLE billing_webhook_events (
  provider text NOT NULL CHECK (provider IN ('stripe')),
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 255),
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 100),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  -- The provider's own time for the event. Projections follow this, not the order of arrival.
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  org_id uuid REFERENCES organizations(id),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'stale', 'unmatched', 'unhandled')),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX billing_webhook_events_unresolved_idx ON billing_webhook_events (received_at) WHERE outcome = 'unmatched';

CREATE TABLE billing_checkouts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  plan text NOT NULL CHECK (plan IN ('pro')),
  provider text NOT NULL CHECK (provider IN ('stripe')),
  provider_session_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed', 'abandoned')),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_session_id)
);
CREATE UNIQUE INDEX billing_checkouts_pending_idx ON billing_checkouts (org_id) WHERE state = 'pending';

-- Cloud's own picture of each organization's subscription, built only from accepted provider events.
CREATE TABLE billing_subscriptions (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  state text NOT NULL CHECK (state IN ('free', 'checkout_pending', 'active', 'past_due', 'cancel_scheduled', 'ended')),
  plan text NOT NULL CHECK (plan IN ('free', 'pro')),
  provider text CHECK (provider IN ('stripe')),
  provider_customer_id text,
  provider_subscription_id text,
  current_period_end timestamptz,
  -- The provider time of the newest event applied. An older event never overwrites a newer one.
  last_event_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id),
  CHECK ((state IN ('free', 'checkout_pending', 'ended')) = (plan = 'free'))
);

-- Invoice metadata only. The document itself stays with the provider, behind its hosted link.
CREATE TABLE billing_invoices (
  provider text NOT NULL CHECK (provider IN ('stripe')),
  invoice_id text NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  number text,
  status text NOT NULL CHECK (status IN ('open', 'paid', 'failed', 'void')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  hosted_url text CHECK (hosted_url IS NULL OR hosted_url ~ '^https://'),
  period_start timestamptz,
  period_end timestamptz,
  last_event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, invoice_id)
);
CREATE INDEX billing_invoices_org_idx ON billing_invoices (org_id, created_at DESC);

-- ── Metering ─────────────────────────────────────────────────────────────────

-- One row per charged thing that happened. The source key names the thing, so recording it twice records it once.
CREATE TABLE usage_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  meter text NOT NULL CHECK (meter IN ('build_minutes', 'function_invocations')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  source_key text NOT NULL UNIQUE CHECK (char_length(source_key) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_period_idx ON usage_events (org_id, meter, occurred_at);
CREATE FUNCTION protect_usage_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A usage event is permanent' USING ERRCODE = '23514', CONSTRAINT = 'usage_event_permanent';
END;
$$;
CREATE TRIGGER usage_event_guard BEFORE UPDATE OR DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION protect_usage_event();

-- A limit an organization sets on itself, inside what its plan includes.
CREATE TABLE usage_budgets (
  org_id uuid NOT NULL REFERENCES organizations(id),
  meter text NOT NULL CHECK (meter IN ('build_minutes', 'function_invocations')),
  monthly_limit bigint NOT NULL CHECK (monthly_limit >= 0),
  -- warn: say so once a month when it is passed. cap: refuse new charged work past it.
  mode text NOT NULL CHECK (mode IN ('warn', 'cap')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, meter)
);
CREATE TABLE usage_warnings (
  org_id uuid NOT NULL REFERENCES organizations(id),
  meter text NOT NULL,
  period date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, meter, period)
);

-- ── Operators ────────────────────────────────────────────────────────────────

-- Operator accounts are their own thing. They are not customer accounts and hold no membership anywhere.
CREATE TABLE operators (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operator_roles (
  operator_id uuid NOT NULL REFERENCES operators(id),
  role text NOT NULL CHECK (role IN ('support', 'security', 'recovery')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, role)
);
CREATE TABLE operator_credentials (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES operators(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A destructive action waits here for a second operator.
CREATE TABLE operator_approvals (
  id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('organization.delete_now')),
  org_id uuid NOT NULL REFERENCES organizations(id),
  -- The organization's revision when the action was asked for. A change since then voids the request.
  target_revision bigint NOT NULL,
  requested_by uuid NOT NULL REFERENCES operators(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'executed', 'rejected')),
  decided_by uuid REFERENCES operators(id),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Nobody approves their own request, whatever the code above this table does.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((state = 'pending') = (decided_by IS NULL))
);
CREATE UNIQUE INDEX operator_approvals_pending_idx ON operator_approvals (org_id, action) WHERE state = 'pending';

-- Everything an operator did or tried to have done, with why. Append-only.
CREATE TABLE operator_actions (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  operator_id uuid NOT NULL REFERENCES operators(id),
  role text NOT NULL CHECK (role IN ('support', 'security', 'recovery')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  org_id uuid REFERENCES organizations(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  approval_id uuid REFERENCES operator_approvals(id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_operator_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'An operator action record is permanent' USING ERRCODE = '23514', CONSTRAINT = 'operator_action_permanent';
END;
$$;
CREATE TRIGGER operator_action_guard BEFORE UPDATE OR DELETE ON operator_actions FOR EACH ROW EXECUTE FUNCTION protect_operator_action();

-- ── Legal holds ──────────────────────────────────────────────────────────────

-- While a hold is in force, nothing of the organization is made finally deleted, by a timer or by anyone.
CREATE TABLE legal_holds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  placed_by uuid NOT NULL REFERENCES operators(id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES operators(id),
  released_at timestamptz,
  CHECK ((released_by IS NULL) = (released_at IS NULL))
);
CREATE INDEX legal_holds_active_idx ON legal_holds (org_id) WHERE released_at IS NULL;
