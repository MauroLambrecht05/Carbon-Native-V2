# Cloud migration operations

Run `bun run --cwd products/carbon-cloud migrate` with `DATABASE_URL` pointing at
the intended Cloud database as an explicit deployment step. The current legacy
server startup also calls the same locked runner; production composition must
separate migration credentials from runtime credentials before cutover.

The runner obtains a transaction-level advisory lock, checks the whole applied
history, then commits new migrations and their SHA-256 checksums together. Do
not change an applied file, insert a version before it, or remove it. CRLF/LF
differences are normalized; all other content changes fail closed.

For the first ledger adoption, unchanged migrations 0001–0004 are idempotently
rerun inside the transaction and recorded. Exercise this against a copy of the
real deployment schema before deployment: a ledger cannot retroactively prove
that an untracked historical database was never manually modified.

0005 only adds human identity structures and organization metadata. It neither
claims existing organizations nor revokes their legacy tokens. A verified owner
claim and published token sunset remain required before production migration.

0006 adds the durable encrypted email queue, browser-bound challenges and request
limits. 0007 adds account security revisions, durable MFA attempt limits, pending
factor expiry and safe command receipts. Its unique partial index allows one
pending or active factor per account; duplicate current factors require explicit
resolution before this migration can apply. No historical migration was rewritten.

0008 binds fresh-auth challenges to sessions and account security revisions.
Any legacy unbound `fresh_auth` rows are marked consumed: no earlier platform API
issued them, and they cannot establish a trusted session-bound authentication.

0009 adds local text avatars and session-bound email changes. The existing email
queue now supports challenge, email-change and account-security-notice owners with
foreign keys and exactly one owner per job. Its generated challenge reference
preserves the old authentication writer's insert column list and queued payloads.

0010 adds account permission revisions, platform-managed organization markers,
durable organization commands/events and ownership proposals. Deferred owner
constraints apply only to platform-managed, non-deleted organizations. Legacy
organizations retain their original ownership state and tokens; no owner is
fabricated or silently claimed by this migration.

0011 binds invitations to the issuing membership/revision and accepting account,
supersedes historical unbound pending proofs, and adds invitation-owned encrypted
mail plus invitation references on security events. Generated challenge ownership
is recreated with the additional job owner; existing payloads and the previous
authentication writer remain compatible. Scoped assignments are not interpreted
until the canonical catalog is implemented.

0012 adds encrypted, browser-bound GitHub authorization flows and the unique
per-account GitHub identity index. Existing verified provider subjects remain
unchanged. Multiple historical GitHub identities for one account must be resolved
explicitly before the unique index can apply. The account worker expires abandoned
flow payloads even if GitHub has subsequently been disabled.

0013-0015 add the canonical project/environment catalog, durable service
provisioning and encrypted import jobs. 0016 stores environment credentials as
hashes and bounded metadata. 0017 stores immutable encrypted secret versions and
wrapping-key identifiers. 0018 adds GitHub App installation/repository metadata,
project bindings, safe command/event records, webhook delivery digests and
immutable commit-resolution evidence. It stores no provider token, private key,
webhook secret, raw webhook body or source content.

0019 adds expiring device authorization requests, hash-only device grants,
bounded polling and request counters, restart-safe decision/revocation receipts,
and metadata-only audit events. Plaintext device codes, user codes and `dc_`
credentials are never stored. Existing sessions and credentials are unchanged.

0020 upgrades the skeletal 0005 service-account identity table with canonical
project/environment scopes, managed status and revisions while marking all prior
rows as legacy. It adds separate hash-only `cs_` credentials, bounded rotation
overlaps, durable command receipts and metadata-only events. It does not infer
scope from broad legacy grants or migrate old `service_credentials` rows.

Before release, take a restorable backup and confirm older application versions
tolerate the additive schema. If a migration fails, PostgreSQL rolls back the
transaction, including ledger records. Fix the unapplied migration and rerun.
After commit, recover by deploying a compatible application version or applying
a reviewed forward repair; never remove ledger rows or drop the new tables to
pretend a migration did not happen. Retain account/session data during recovery.

Integration tests exercise fresh databases, baseline adoption, concurrent
deployers, history drift and failure/retry against real PostgreSQL. They do not
replace a staging backup/restore drill or authorize production deployment.

0021 adds hash-only personal credentials with their command and event tables,
and additive status, usage and retirement columns on the legacy `api_tokens`
table with `legacy_token_commands` and `legacy_token_events`. Existing legacy
rows keep their hash and default to `active`. Recovery: code from before 0021
ignores the new columns, so a release rollback needs no schema change; it does
treat retired legacy tokens as accepted again. See
[legacy-tokens.md](legacy-tokens.md).

0022 adds enrolled `workers`, `worker_leases`, `worker_commands` and
`worker_events`. It is additive and touches no existing table. Recovery: code
from before 0022 ignores these tables; dropping them loses only worker
enrollments and lease history, never secret data.

0023 adds `platform_events`, one ordered organization-scoped log, with triggers
on the eleven existing event tables that write to it in the source transaction.
It also adds deletion schedule columns to `projects`, `environments` and
`organizations` and a suspension reason. Existing rows are untouched and earlier
events are not backfilled. Recovery: code from before 0023 ignores the new table
and columns; the triggers keep writing harmlessly. See
[audit-events.md](audit-events.md) and
[resource-lifecycle.md](resource-lifecycle.md).

0024 adds application authentication: `realms`, `realm_providers`, `app_users`,
`app_identities`, `app_challenges`, `app_email_outbox`, `app_sessions`,
`app_auth_rate_limits`, `realm_commands` and `app_auth_events`, with a trigger
that copies app events into `platform_events`. It is additive and leaves the
legacy `end_users` tables of 0004 untouched. Recovery: code from before 0024
ignores these tables.

0025 adds `worker_rate_limits` and backfills `platform_events` from the eleven
source event tables for rows written before 0023. Backfilled rows are placed
under transaction 3 so they sort before every event recorded by the triggers.
The statement skips rows already present, so it is safe to repeat. Recovery:
code from before 0025 ignores both.

0026 adds canonical builds: `platform_builds`, `build_attempts`,
`build_log_segments`, `build_artifacts`, `build_commands` and `build_events`,
with triggers that make a build's input, a finished state, and stored logs and
artifacts unchangeable, and a trigger that copies build events into
`platform_events`. It is additive and leaves the legacy `builds` table of 0001
untouched. Recovery: code from before 0026 ignores these tables.

0027 adds `build_provenance`: one row per succeeded build holding the provenance
statement, its exact serialized text, its SHA-256 and, when a signing key is
configured, an Ed25519 signature and key identifier. Rows cannot be updated or
deleted. It is additive. Recovery: code from before 0027 ignores the table, but
that code also accepts a build without verifying its artifacts.

0028 adds releases and channels: `signing_profiles`, `update_feeds`, `releases`,
`release_artifacts`, `channels`, `channel_revisions`, `release_commands` and
`release_events`. Triggers make a release immutable except for one withdrawal,
make release artifacts, channel revisions and signing profiles append-only, and
copy release events into `platform_events`. It is additive and leaves the legacy
`releases`-in-object-storage layout untouched. Recovery: code from before 0028
ignores these tables.

0029 adds table exports: `data_export_jobs`, `data_export_parts`,
`data_export_downloads`, `data_export_commands` and `data_export_events`, with a
trigger that copies export events into `platform_events`. It is additive.
Recovery: code from before 0029 ignores these tables; objects already written to
the export bucket would then need to be removed by hand.

0030 adds functions: `functions`, `function_revisions`, `function_schedules`,
`function_executions`, `function_commands` and `function_events`. Triggers make
a revision immutable, pin what an execution runs, freeze a finished execution,
and copy function events into `platform_events`. It is additive. Recovery: code
from before 0030 ignores these tables, but its lease sweeper would then retry
and expire `function` leases without ending their executions, so cancel open
executions before rolling back.

0031 adds billing, metering, operators and legal holds: `billing_webhook_events`,
`billing_checkouts`, `billing_subscriptions`, `billing_invoices`, `usage_events`,
`usage_budgets`, `usage_warnings`, `operators`, `operator_roles`,
`operator_credentials`, `operator_approvals`, `operator_actions` and
`legal_holds`. Triggers make usage events and operator action records
permanent, and a constraint refuses an approval decided by its own requester.
It is additive; `org_plans` and `usage_records` are kept and still written.
Recovery: code from before 0031 ignores these tables, and would then make
deletions final without regard to legal holds or live subscriptions, so do not
roll back while a hold is in force.

Foreign keys need no migration in Database: they are a new kind of entry in the
existing `canonical_data_constraints` catalog.

Registry publishing adds no Cloud migration. In Registry, `0004_publishing.sql`
adds `registry_publishers`, `registry_packages`, `registry_versions`,
`registry_review_records`, `registry_commands` and `registry_package_events`.
Triggers fix a version's identity and bytes, allow only forward state changes,
freeze published, rejected and revoked versions, forbid deleting any version,
and make review records permanent. It is additive and leaves the legacy
`plugins` and `plugin_versions` tables untouched. Recovery: code from before
0004 ignores these tables; archives already written to the bucket under
`quarantine/` and `packages/` would then need to be removed by hand.

Blob storage adds no Cloud migration. Its tables are Database migration
`0008_blob_storage.sql` (`blob_buckets`, `blob_objects`, `blob_transfers`,
`blob_commands`, `blob_events`, `blob_usage`), which is additive and leaves the
legacy `storage_buckets` and `storage_files` tables untouched.

Realtime, vectors and graph add no Cloud migration. In Database, `0009_data_changes.sql`
adds the change feed (`data_change_events`, `data_change_pruned`, the capture
trigger function, and a trigger on every existing canonical table), and
`0010_vector_graph.sql` adds `canonical_vector_collections`,
`canonical_vector_points`, `canonical_graph_nodes`, `canonical_graph_edges` and
`engine_commands`. Both are additive and leave the legacy vector, graph and
realtime structures untouched. 0009 changes behaviour for existing tables: every
row change from then on also writes one feed row in the same transaction.

Functions gain calendar schedules, logs and retention in Cloud migration
`0032_function_calendar_logs.sql`. It makes `function_schedules.interval_seconds`
nullable and adds `cron`, `time_zone`, `input` and the last-skip columns, with
constraints that a schedule is exactly one kind; adds `function_execution_logs`;
and adds `has_logs` and `pruned_at` to `function_executions`. It replaces the
`protect_function_record` trigger function so that a finished execution allows
one change, the removal of its input, output and logs. It is additive.
Recovery: code from before 0032 reads a calendar schedule's null interval as
an error when that schedule comes due, so pause or delete calendar schedules
before rolling back past it; interval schedules are unaffected. Older code
never prunes, and ignores the log table.

## Running migrations as a release step

Phase 18 adds no migration. Each service has `bun run migrate` (apply what is
pending) and `bun run migrate status` (print applied, pending and drift as
JSON, change nothing, exit non-zero unless the database is exactly at this
code's version). With `CARBON_MIGRATE_ON_START=disabled` a service does not
migrate when it starts and refuses to start on a schema it may not serve; with
`CARBON_NEWER_SCHEMA=allowed` as well, it serves a schema that is ahead of it,
which is how a rollback is done. The status check creates nothing: against a database with no ledger
table it reports everything as pending. See [operations.md](operations.md).
