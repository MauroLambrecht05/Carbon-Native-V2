# Operating Carbon Cloud, Database and Registry

What a running service tells its operators, how a release is rolled out, and
what to do when something breaks. This document describes what exists after
Phase 18.

**None of this has run in production.** There has never been a deployment of
this platform (G-03). The endpoints, commands and drills below are tested
against real databases on a development machine. The runbooks are written from
the code and have not been used in an incident.

## The three endpoints every service has

| Endpoint | Meaning | Use it for |
|---|---|---|
| `GET /healthz` | The process is up. It checks nothing else | Liveness: restart the process if this fails |
| `GET /readyz` | The service can do its work | Readiness: send traffic only while this answers `200` |
| `GET /metrics` | Prometheus text | Scraping, with the scrape token |

### Readiness

`/readyz` answers `200` when every check passes and `503` otherwise:

```json
{ "ready": false, "checks": { "database": "ok", "migrations": "failed" } }
```

- **database:** the service's database answers a query.
- **migrations:** the database holds exactly the schema this code ships. A
  database with a migration still to run is not ready. Neither is one that is
  ahead of the code, or whose history was edited.

The checks only read. The answer names the checks and gives no error text,
address or version, because whoever can reach a probe is not necessarily an
operator.

A dependency being down fails `/readyz` and not `/healthz`, so an outage of the
database does not get every process restarted.

### Metrics

`/metrics` exists only when `CARBON_METRICS_TOKEN` is set (at least 24
characters), and only for a request that presents it as a bearer token.
Otherwise it answers `404`, as if it were not there.

Per request, from every service:

| Metric | Labels |
|---|---|
| `carbon_http_requests_total` | `service`, `route`, `method`, `status` |
| `carbon_http_request_duration_seconds` | `service`, `route`, `method` |
| `carbon_http_denied_total` (401 and 403 only) | `service`, `route`, `status` |

Read from the database when scraped:

| Service | Metric | What it shows |
|---|---|---|
| Cloud | `carbon_operations_open`, `carbon_operations_oldest_seconds` | Provisioning that has not finished |
| Cloud | `carbon_worker_leases_open`, `carbon_worker_leases_overdue` | Work on workers; overdue means the sweeper is behind or down |
| Cloud | `carbon_builds_open`, `carbon_builds_oldest_queued_seconds` | Builds waiting for a worker |
| Cloud | `carbon_function_executions_open`, `..._oldest_queued_seconds` | Function executions waiting for a worker |
| Cloud | `carbon_email_outbox_pending`, `..._oldest_seconds` | Email not sent yet |
| Cloud | `carbon_data_jobs_open` | Imports and exports in progress |
| Cloud | `carbon_billing_events_unmatched`, `carbon_billing_last_event_seconds` | Provider events nobody could place; time since the provider last called |
| Cloud | `carbon_deletions_blocked`, `carbon_operator_approvals_pending` | Deletions held back; requests waiting for a second operator |
| Database | `carbon_environments`, `carbon_change_feed_events`, `carbon_change_feed_oldest_seconds`, `carbon_blob_transfers_open` | Environments, change feed size and age, transfers in progress |
| Registry | `carbon_registry_versions`, `carbon_registry_review_oldest_seconds`, `carbon_registry_publishers` | Versions by state; how long the oldest has waited for review |
| Database, Registry | `carbon_assertion_replays` | Assertion identifiers kept to refuse replays |

Every value is a count or an age in seconds. No metric carries an identifier, a
name or anything a customer wrote.

Not measured yet: storage and egress, realtime connections, function
saturation, backup age (there are no backups), and anything on a worker
(G-155).

### Logs

Each request writes one JSON line to standard output:

```json
{"time":"2026-10-11T08:00:00.000Z","event":"http.request","service":"carbon-cloud","requestId":"...","method":"POST","route":"/platform/v1/orgs/:id/billing","status":200,"durationMs":41}
```

The line has a **route**, not a path. Identifiers become `:id`; anything else
that is not one of the API's own words becomes `:value`, including tokens in
URLs and names customers chose. The query, headers, body, client address and
account are never written.

A handler that fails writes an `http.failure` line with the route and the error
text. The text is passed through redaction first, which removes anything
shaped like a Carbon credential, a provider key, a signed assertion, a bearer
header, a password in a connection string, or a PEM block.

`requestId` is the correlation identifier. It is the one Cloud sends to
Database and Registry in `x-request-id`, and the one in audit events and error
responses, so one request can be followed across services by searching for it.
There is no distributed tracing (G-156).

The legacy routes under `/v1` and `/api` in Cloud are not observed (G-157).

## Releasing

### Migrations

Each service owns its migrations and its ledger table
([migrations.md](migrations.md)). Migrations are forward-only, checksummed, and
applied under an advisory lock, so two deployers cannot run them at once.

```
bun run --cwd products/carbon-cloud migrate            # apply what is pending
bun run --cwd products/carbon-cloud migrate status     # report; changes nothing
```

`migrate status` prints what is applied, what is pending and where the history
drifted, and exits non-zero unless the database is exactly at this code's
version. The same commands exist for `carbon-database` and `carbon-registry`.

By default a service also applies its own migrations when it starts. To run
them as a separate release step, set `CARBON_MIGRATE_ON_START=disabled`: the
service then starts against the schema it finds and reports not ready until it
is the right one.

### Order

1. `migrate status` on each database. Stop if there is drift.
2. Back up. **There is no backup tooling in this repository** (G-135); use the
   database provider's.
3. `migrate` for the service being released.
4. Start the new version. Wait for `/readyz`.
5. Move traffic. Stop the old version.

Migrations are additive, and each has a recovery note in
[migrations.md](migrations.md) saying what older code does with the new schema.
An older version stays ready only until the schema moves: after step 3 its
`/readyz` fails, by design, so steps 3 to 5 should be close together.

Running Cloud, Database and Registry one version apart has not been tested
(G-158).

## Rotating keys and secrets

Each of these was exercised in a test, with the service restarted where a real
rotation would restart it. None has been done on a deployment.

| What | How | Tested in |
|---|---|---|
| Cloud's assertion signing key | Add the new public key to Database's and Registry's trust with an overlap, switch Cloud to sign with it, then remove the old key | `service-assertions.test.ts`, "allows pinned rotation overlap" |
| Registry's package signing key | Root signs a bundle with the new key `active` and the old `retiring`; restart Registry on the new key; later a bundle with the old key `revoked` | Rotation drill in `platform-lifecycle.integration.test.ts` |
| The message encryption key | Add the new key, make it active, remove the old one when nothing sealed with it is needed | `key-rotation.test.ts` |
| The payment provider's webhook secret | Set the new secret and keep the old as `STRIPE_WEBHOOK_SECRET_PREVIOUS`; remove it when the provider has switched | Billing test in `account-auth.integration.test.ts` |
| Environment secrets, credentials, service accounts, personal and worker credentials | Rotate through the API; the old value stops working at once | Their own tests in `account-auth.integration.test.ts` |

What the Registry drill shows: Registry refuses to start on a bundle that does
not list its key as active; versions signed by a retiring key stay
installable; versions signed by a revoked key are refused by every installer
that has seen the new bundle; and an installer that has seen a newer bundle
cannot be walked back to an older one.

Not rotated by any procedure here: the Registry root key, Windows signing
certificates, the KMS key (G-115, G-01).

## Runbooks

Written from the code. Not used in an incident.

### The payment provider is unreachable or stops calling

- **Signs:** `carbon_billing_last_event_seconds` keeps rising; checkouts answer
  `503`.
- **Effect:** subscriptions stay as they were. Nobody loses a plan because the
  provider is quiet.
- **Do:** nothing in Cloud. The provider retries events it could not deliver,
  and each is applied once in its own order when it arrives.
- **After:** look at `carbon_billing_events_unmatched`. There is no tool yet to
  resolve those (G-138).

### Object storage is unavailable

- **Signs:** uploads and downloads answer `503`; builds fail verification.
- **Effect:** nothing is recorded as stored that was not. A blob upload that
  could not be written leaves no object and no row; a build is not marked
  succeeded without its artifacts read back.
- **Do:** restore storage. Interrupted uploads are retried by their clients
  with a new transfer; exports resume from their last completed part.

### The database fails over

- **Signs:** `/readyz` fails on `database`; requests answer `503`.
- **Effect:** every change is a transaction, so work in flight is either
  committed or not there.
- **Do:** when the database is back, check `migrate status`, then `/readyz`.
  Workers that lost their leases are handled by the lease sweeper; nothing
  needs to be restarted by hand.

### A build or function execution is stuck

- **Signs:** `..._oldest_queued_seconds` rising; `carbon_worker_leases_overdue`
  above zero.
- **Do:** check that `worker-lease-sweeper` is running: it expires overdue
  leases, re-offers the work up to three times, then ends it as `worker_lost`,
  and it ends anything past its deadline. Check that a worker with the right
  purpose is enrolled and polling. A customer can cancel either from the API.

### A key is compromised

- **Cloud's assertion key:** remove its public key from Database's and
  Registry's trust and restart them. Every assertion it signed stops working
  within the 60 seconds they live anyway.
- **Registry's signing key:** have the root sign a bundle that revokes it,
  restart Registry on a new key, and re-publish what it signed. Installers that
  fetch the new bundle refuse everything the old key signed.
- **A customer credential:** revoke it through the API; it stops on its next
  use.
- **The Registry root key:** there is no procedure (G-115).

### A package must be pulled from Registry

`bun run review revoke <versionId> --operator <name> --reason <text>`. The
version is never served again and stays listed as revoked, so projects that
have it learn of it from `carbon plugin registry audit`.

### Provider events were replayed or arrived out of order

Nothing to do. An event is applied once by its provider identifier, and an
older event never overwrites a newer one. To confirm, compare
`billing_webhook_events` with the provider's own event log.

### A restore is needed

There is no restore procedure, because there is no backup tooling (G-135).

## Alerts worth having

Suggested from the metrics above. No thresholds are given: none has been
measured, and a number invented here would be a promise nobody tested.

- `/readyz` failing on any service.
- `carbon_worker_leases_overdue` above zero for longer than the sweep interval.
- Any `..._oldest_queued_seconds` or `carbon_registry_review_oldest_seconds`
  rising without bound.
- `carbon_http_denied_total` rising sharply on one route.
- `carbon_billing_events_unmatched` above zero.
- `carbon_email_outbox_oldest_seconds` rising.

## What is not built

See G-154 to G-165 in [the gap ledger](left-off/gaps.md).
