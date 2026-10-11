# Carbon platform left-off checkpoint

Checkpoint: 2026-10-11, after Phase 18: observability, release steps, rotation drills and the security and cutover documents.

The overall platform plan remains unfinished. The rough scope estimate is about
**45% of the complete backend-and-frontend goal**: most backend areas exist
with recorded gaps, one part of the console is connected to them, and the
requested production frontend redesign is still at **0%**. These are planning estimates, not release-readiness measurements.

## Completed through this checkpoint

- Shared strict contracts, generated TypeScript and request conventions.
- Human account authentication, MFA, sessions, organizations, invitations,
  scoped membership authority and the canonical project/environment catalog.
- Database and Registry lifecycle provisioning foundations and signed service
  authority.
- Relational metadata, restricted row operations, schema changes and durable
  bounded imports.
- Exact-environment `ce_` credentials and versioned encrypted environment
  secrets.
- GitHub App installation discovery, project repository binding, immutable ref
  resolution, proposal reconciliation and signed webhook handling.
- Account-approved device authorization with one-time `dc_` credentials.
- Managed exact-scope service accounts, one-time `cs_` credentials, rotation,
  disable/enable, revocation, and 60-second request-bound Database assertions.
- Carbon CLI device login/logout, OS credential storage with token-free local
  metadata, and canonical `db data` execution through exact 60-second Database
  assertions with live revocation.
- Registry assertion exchange for device and service-account credentials on
  separate contracts and routes, a canonical Registry `namespace.get` request,
  and Registry-only live authority. Database and Registry assertions cannot
  cross audiences.
- Personal `pt_` credentials with one-time disclosure, hash-only storage,
  exact delegated scope, rotation and revocation.
- A staged deprecation policy for legacy `cc_` organization tokens, an owner
  claim for legacy organizations, and reversible retirement of legacy tokens.
- Worker enrollment with `we_` codes and `wc_` credentials, leases with
  one-time `wl_` tokens, single-use lease-bound secret delivery, a lease
  sweeper, and an AWS KMS custody adapter.
- One ordered organization event log, audit browsing, a live event stream,
  scheduled and recoverable deletion for environments, projects and
  organizations, operator suspension, and a two-tenant denial matrix.
- Application authentication: one realm per environment, emailed sign-in links,
  OIDC providers, app sessions, and Database row access as a verified app user.
- Build orchestration on worker leases: immutable input, quota reservation,
  attempts, ordered logs, declared artifacts, cancellation and recovery.
- Build execution, in part: Cloud verifies every declared artifact against
  object storage and records signed provenance; a worker runtime checks out the
  pinned commit into a disposable workspace, requires a lockfile, redacts
  secrets from logs and erases the workspace before reporting success. Real
  NSIS/WiX packaging, Authenticode signing and build isolation are unproven.
- Releases and channels: immutable releases over verified build artifacts,
  signing profiles backed by environment secrets, signed channel revisions,
  promotion, rollout, withdrawal with a stop list, and a public update feed.
- One shared update conformance fixture, run by the TypeScript updater, the
  Rust runtime updater and the standalone updater.
- Foreign keys between tables of one environment, with schema previews that show
  and block changes other tables depend on.
- Private, resumable, cancellable table exports with single-use downloads.
- Blob storage in Carbon Database: private and public buckets, exact-byte
  single-use transfers verified before storing, versions and retention, quota,
  cleanup and metering.
- A change feed captured in the database for every canonical table, read in
  commit order under row policy, with a resumable stream for the browser.
- Vector collections with exact deterministic search, and one bounded property
  graph per environment.
- Functions and schedules, in part: immutable revisions, executions pinned to
  one revision on worker leases that carry exactly that revision's secrets,
  cancel, retry, timeout and lost-worker recovery, interval schedules that run
  each slot at most once, and a worker that runs the code in its own process.
  Functions are not isolated and have no logs.
- Registry publishing: organization-owned publisher names, exact uploads
  inspected into quarantine, operator review, statements signed under a
  root-signed trust bundle, yanking, security revocation, public distribution,
  and the checks an installer must make.
- Plugin consumption, in part: `carbon plugin registry` resolves a package to an
  exact version this host can load, verifies it against a root key pinned in
  the project, records it in a lock, and installs from the lock, online or
  from a local cache. An installed package is not yet loaded by an app.
- Billing, in part: a subscription picture built only from the provider's signed
  events, applied once and in the provider's order; plan allowances and
  organization budgets enforced under one count per organization; usage
  metered once per charged thing.
- Operators: separate accounts with scoped roles, a reason and the current
  revision for every act, a permanent record, and two people for an early
  deletion. Legal holds and live subscriptions stop final deletion.
- The console, in part: a production browser composition with no mock in it,
  and live adapters for accounts, organizations, members, invitations, projects
  and environments. Every other area of the console says it is not connected.
- Operations, in part: liveness, readiness and metrics endpoints on all three
  services, one structured log line per request with a route and no values,
  a read-only migration status, migrations as a separate release step, and
  rotation of Registry's signing key, the message key and the webhook secret
  exercised in tests. Nothing has run in a deployment.

The service-account implementation is described in
[service-accounts.md](../service-accounts.md), its wire surface in
[service-account-api.openapi.json](../service-account-api.openapi.json), and its
additive storage in migration `0020_service_accounts.sql`. Migration 0020 leaves
the skeletal migration-0005 service-account records explicitly unmanaged; no
legacy permissions are inferred.

## Last verified state

- Affected Bun regression: **742 tests, 0 failures and 9,035 assertions across 93 files, with the object-store tests run against a local MinIO container**,
  including the real HTTP/PostgreSQL cross-service suites. These database
  scenarios run on the development machine only: CI has no database and skips
  them (G-50).
- The Rust updater's 18 tests pass, including the conformance fixture.
- Solutions, Carbon Cloud, Database, Registry and CLI TypeScript checks passed.
- Generated platform types are current.
- The build OpenAPI document parses as JSON.
- The build, release, function and Registry publishing OpenAPI documents parse as JSON.
- A full local `bazel build //...` passed on 2026-10-10 before Phases 2 to 7. Local
  `bazel test //...` is unreliable while `defs.bzl` runs `cargo sweep` after
  every Cargo invocation: parallel Rust tests delete each other's build output
  from the shared target directory. That `defs.bzl` change is still uncommitted.

The PostgreSQL regressions used
`postgres://carbon_test:carbon_test_local_only@127.0.0.1:55439/carbon_platform_test`
and
`postgres://carbon_test:carbon_test_local_only@127.0.0.1:55440/carbon_service_test`.
No production provider credentials were installed and no production deployment
or customer cutover was performed.

## Deliberate boundary

Every open gap is listed, with its reason, in [gaps.md](gaps.md). Read it before
starting a phase and update it in the same commit as the work.

This checkpoint supports exact Database and Registry assertion exchange for
service accounts and CLI device credentials, personal credentials, enrolled
workers that receive leased secrets, a browsable and streamable organization
event log, recoverable deletion, and application authentication with Database
row access for app users. Personal credentials exchange for Database and
Registry assertions, and the CLI can read its Registry namespace. Builds are
orchestrated on worker leases, verified against object storage and given signed
provenance, and a worker runtime runs them in a disposable workspace. That
runtime has never compiled, packaged or signed a real Carbon app, and it does
not isolate or limit a build (G-36 to G-38). Releases, channels and the public
update feed work against the updaters' shared rules, but no packaged app has
updated itself from a Cloud channel yet (G-57), and the CLI still publishes
through the older S3 path (G-59). The
AWS KMS adapter and the OIDC client are tested against stand-ins, not real
providers. Final deletion marks rows and destroys no owning-service data.
Suspension has no operator route. Legacy `cc_` and `wk_` tokens, the legacy
build queue and the legacy end-user routes still work as before. Existing legacy
implementations elsewhere in the repository still need review against the new
isolation, durability and trust requirements before they count as complete.

Phases 8, 10, 13, 15, 16, 17 and 18 are **partly complete**; Phases 9, 11, 12 and 14 are complete. By
the owner's decision (2026-10-10), open decisions and everything a phase could
not finish or prove are collected in [gaps.md](gaps.md) and worked in a final
Phase 19; phases do not stop for them.

Functions run on worker leases with pinned revisions and leased secrets, but a
function is an unisolated child process of the worker with no resource limits
and no logs (G-100, G-102), only an account session can invoke one (G-104), and
schedules are plain intervals (G-101).

Registry publishes reviewed, signed packages and serves them publicly, and the
CLI installs them into a project by declaration and lock with pinned trust. An
installed package still cannot run: the build does not stage it and the loader
does not accept Registry's signatures (G-126). Cloud has no project plugin API
(G-127), and the legacy Registry API and CLI paths still exist (G-118, G-128).
Review is an operator's command-line tool with no operator accounts (G-114),
and the signing key is not in a KMS (G-115).

Billing has never run against the real payment provider (G-136), and backup
and restore do not exist (G-135). Final deletion is gated by holds, live
subscriptions and two operators, but still destroys nothing in the owning
services (G-09). Operators have no sign-in of their own (G-141).

The console's production build talks to the real API for accounts and
organizations only (G-147), has never run in a real browser (G-151), and has no
visual design (G-152).

Phase 18's gate asks for production evidence, and there is no deployment, so it
is not met (G-154). The services can now say whether they are ready and what
their queues look like, and a release can run migrations as its own step, but
no restore, rollback or version-skew drill has been run (G-135, G-158), there is
no threat model or independent security review (G-159), and nothing can be
enabled for a canary set of organizations (G-162). See
[operations.md](../operations.md), [security-review.md](../security-review.md)
and [cutover.md](../cutover.md).

The next bounded goal is **Phase 19: close the gap ledger**. It is the last
phase. [handoff.md](handoff.md) sorts the ledger into what can be done in the
repository, what needs something from outside, and what needs the owner's
decision.
