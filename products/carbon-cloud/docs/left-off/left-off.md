# Carbon platform left-off checkpoint

Checkpoint: 2026-09-13, after Phase 1: Carbon CLI device login and exact
Database assertion consumption.

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

The service-account implementation is described in
[service-accounts.md](../service-accounts.md), its wire surface in
[service-account-api.openapi.json](../service-account-api.openapi.json), and its
additive storage in migration `0020_service_accounts.sql`. Migration 0020 leaves
the skeletal migration-0005 service-account records explicitly unmanaged; no
legacy permissions are inferred.

## Last verified state

- Affected Bun regression: **123 tests, 2,122 assertions, 0 failures across 16
  files**. The focused CLI suite is 20 tests/180 assertions, and the real
  HTTP/PostgreSQL device lifecycle has 44 focused assertions.
- Affected Bazel validation: **17 of 17 targets passed**.
- Solutions, Carbon Cloud and Carbon CLI TypeScript checks passed.
- Generated platform types are current.
- The platform schema and device-authorization OpenAPI parse as JSON.
- The scoped Phase 1 files pass whitespace validation at this checkpoint.

The PostgreSQL regression used
`postgres://carbon_test:carbon_test_local_only@127.0.0.1:55439/carbon_platform_test`.
No production provider credentials were installed and no production deployment
or customer cutover was performed.

## Deliberate boundary

This checkpoint supports exact Database assertion exchange for service accounts
and CLI device credentials. It does not yet provide Registry exchange,
automated row-policy semantics, personal credentials, worker
enrollment/credentials, hosted KMS/HSM secret custody, or build/function secret
leases. Existing legacy implementations
elsewhere in the repository still need review against the new isolation,
durability and trust requirements before they count as complete.

The next bounded goal is **Phase 2: Registry assertion exchange**. Continue with
exactly one phase from [handoff.md](handoff.md) per future work
session. Finish that phase's proof gate, update both checkpoint documents, and
stop before beginning the next phase unless the user explicitly combines them.
