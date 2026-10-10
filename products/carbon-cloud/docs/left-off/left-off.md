# Carbon platform left-off checkpoint

Checkpoint: 2026-10-10, after Phase 4: workers, leases, hosted custody and secret
delivery.

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

The service-account implementation is described in
[service-accounts.md](../service-accounts.md), its wire surface in
[service-account-api.openapi.json](../service-account-api.openapi.json), and its
additive storage in migration `0020_service_accounts.sql`. Migration 0020 leaves
the skeletal migration-0005 service-account records explicitly unmanaged; no
legacy permissions are inferred.

## Last verified state

- Affected Bun regression: **505 tests, 4,723 assertions, 0 failures across 61
  files**, including the real HTTP/PostgreSQL cross-service suites.
- Solutions, Carbon Cloud, Database, Registry and CLI TypeScript checks passed.
- Generated platform types are current.
- The worker OpenAPI document parses as JSON.
- A full local `bazel build //...` passed on 2026-10-10 before Phases 2 to 4. Local
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

This checkpoint supports exact Database and Registry assertion exchange for
service accounts and CLI device credentials, management and verification of
personal credentials, and enrolled workers that receive leased secrets. Nothing
grants worker leases in production yet: build and function orchestration are
later phases. The AWS KMS adapter is tested against a stand-in, not a real AWS
account. Personal credentials cannot yet be exchanged for service assertions.
Legacy `cc_` and `wk_` tokens and the legacy build queue still work as before.
Existing legacy implementations elsewhere in the repository still need review
against the new isolation, durability and trust requirements before they count
as complete.

The next bounded goal is **Phase 5: lifecycle gaps — streams, audit browsing,
archive/deletion/suspension/recovery, revocation propagation and adversarial
tenant coverage**. Continue with
exactly one phase from [handoff.md](handoff.md) per future work
session. Finish that phase's proof gate, update both checkpoint documents, and
stop before beginning the next phase unless the user explicitly combines them.
