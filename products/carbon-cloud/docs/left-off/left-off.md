# Carbon platform left-off checkpoint

Checkpoint: 2026-10-11, after Phase 10: relational data (partly complete).

The overall platform plan remains unfinished. The rough scope estimate is about
**30% of the complete backend-and-frontend goal**, with backend foundations in
the **low 40% range** and the requested production frontend redesign still at
**0%**. These are planning estimates, not release-readiness measurements.

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

The service-account implementation is described in
[service-accounts.md](../service-accounts.md), its wire surface in
[service-account-api.openapi.json](../service-account-api.openapi.json), and its
additive storage in migration `0020_service_accounts.sql`. Migration 0020 leaves
the skeletal migration-0005 service-account records explicitly unmanaged; no
legacy permissions are inferred.

## Last verified state

- Affected Bun regression: **679 tests, 0 failures and 6,661 assertions across 83 files, with the two object-store tests run against a local MinIO container**,
  including the real HTTP/PostgreSQL cross-service suites. These database
  scenarios run on the development machine only: CI has no database and skips
  them (G-50).
- The Rust updater's 18 tests pass, including the conformance fixture.
- Solutions, Carbon Cloud, Database, Registry and CLI TypeScript checks passed.
- Generated platform types are current.
- The build OpenAPI document parses as JSON.
- The build and release OpenAPI documents parse as JSON.
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

Phases 8 and 10 are **partly complete**; Phase 9 is complete. Phase 10 has
foreign keys, cross-table impact previews and exports, and does not have
restricted SQL, migration promotion, asynchronous schema changes or table
deletion (G-64 to G-67). By the owner's decision (2026-10-10), open decisions
and everything a phase could not finish or prove are collected in
[gaps.md](gaps.md) and worked in a final Phase 19; phases do not stop for them.

The next bounded goal is **Phase 11: blob storage with private objects, signed
bounded transfers, metadata authority, retention and cleanup**. Continue with
exactly one phase from [handoff.md](handoff.md) per future work session. Finish
that phase's proof gate, update both checkpoint documents, and stop before
beginning the next phase unless the user explicitly combines them.
