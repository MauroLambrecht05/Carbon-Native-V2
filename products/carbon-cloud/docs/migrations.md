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
