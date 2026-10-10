# Carbon platform phase-by-phase handoff

This document turns the remaining
[backend plan](../platform-backend-plan.md) and
[frontend plan](../platform-frontend-plan.md) into bounded future work. Treat
each row as a separate goal. A phase is complete only when its contracts,
additive migrations, authority checks, durable behavior, documentation and
meaningful tests pass together.

## Recommended sequence

| Phase | Bounded goal | Exit proof |
|---|---|---|
| 1 — complete | Make Carbon CLI complete device login, store `dc_` credentials safely, and exchange authorized CLI requests for exact Database assertions. | Completed: device flow, OS credential storage, exact Database request binding and live revocation are covered by CLI and PostgreSQL-backed tests. |
| 2 — complete | Extend exact short-lived assertion exchange to Registry without widening Database or credential audiences. | Completed: separate Registry exchange contracts and routes, a canonical Registry request, and cross-service tests proving Database and Registry assertions cannot cross and that revocation is live. |
| 3 — complete | Add personal credentials and a reviewed migration/deprecation path for legacy `cc_` credentials. | Completed: `pt_` credentials with one-time disclosure, hash-only storage, exact delegated scope, rotation and revocation; staged `cc_` deprecation, owner claim and reversible retirement; cross-tenant tests pass. |
| 4 | Add worker enrollment, lease-scoped worker credentials, hosted KMS/HSM custody, and short-lived build/function secret materialization. | A worker can obtain only its leased inputs; browser/data routes cannot materialize secrets; expiry, cancellation, replay, key rotation and worker loss are tested. |
| 5 | Finish BE-01 to BE-03 lifecycle gaps: streams, audit browsing, archive/deletion/suspension/recovery, revocation propagation and adversarial tenant coverage. | Every affected resource has a tested state machine, durable events, recovery path and two-tenant denial matrix. |
| 6 | Implement BE-04 application authentication realms, app users, identities, providers, challenges and sessions. | Signup policy, verified magic-link/OIDC, redirect allowlists, rotation/revocation, rate limits and app-audience Database policy context pass end-to-end tests. |
| 7 | Implement BE-06 build orchestration: immutable source snapshots, quota reservations, attempts, leases, heartbeats, cancellation and ordered logs. | Lost/reclaimed workers, duplicate commands, quota release, log ordering and immutable input/artifact references are proven durably. |
| 8 | Implement disposable Windows x64 execution, dependency locks, NSIS/WiX packaging, signing and provenance. | A clean Windows worker builds a pinned commit under resource/egress limits and emits verified immutable artifacts and provenance. |
| 9 | Implement BE-07 releases, channel revisions, rollout/promotion/withdrawal and updater compatibility. | Publisher, TypeScript, standalone and Rust consumers pass shared digest/signature, rollback and channel-transition conformance. |
| 10 | Finish BE-08 relational work: private exports, foreign keys, impact previews, asynchronous schema work, migration promotion and restricted SQL. | Authorization, cancellation, resumability, dependency impact and large-job recovery pass real Database integration tests. |
| 11 | Implement BE-09 blob storage with private objects, signed bounded transfers, metadata authority, retention and cleanup. | Two-tenant upload/download/delete, interrupted transfer, expiry, quota and orphan cleanup scenarios pass. |
| 12 | Implement BE-09 vector, graph and realtime parity with canonical environment authority and durable outbox semantics. | Exact-scope CRUD/query isolation and reconnect/replay/revocation tests pass for every service. |
| 13 | Implement BE-10 functions and schedules with immutable revisions, secret bindings, leases, limits and durable executions. | Deploy/invoke/schedule/cancel/retry tests prove revision pinning, secret isolation, idempotency and timeout recovery. |
| 14 | Implement BE-11 Registry publisher identity, review, trust, immutable archives, yanking and signed distribution. | Publish/review/install tests verify namespace authority, provenance, digest/signature checks, revocation and tenant isolation. |
| 15 | Implement BE-12 project plugin consumption and the remaining CLI workflows. | Lockfile, install/update/remove, compatibility and offline/error recovery pass against real Registry and project APIs. |
| 16 | Implement BE-13 billing, quotas, operator boundaries, recovery, deletion and unknown-outcome resolution. | Provider webhook replay, quota races, operator audit, backup/restore and irreversible-deletion gates pass. |
| 17 | Complete production browser adapters and the Carbon frontend one vertical slice at a time. | Each frontend-plan walkthrough passes against real services; production bundles contain no mock imports or mock data. |
| 18 | Complete observability, deployment compatibility, security review, migration reconciliation, canary rollout and cutover. | Sections 25-29 of the backend plan have recorded production evidence, including restore, rotation, rollback and no-mock-fallback drills. |

## Start with Phase 4

Phases 1 to 3 are complete. Read these files before changing Phase 4 code:

- [environment-secrets.md](../environment-secrets.md)
- [personal-credentials.md](../personal-credentials.md)
- [legacy-tokens.md](../legacy-tokens.md)
- `solutions/capabilities/cloud/catalog/application/usecases/AccountEnvironmentSecrets.ts`
- `solutions/capabilities/cloud/catalog/infrastructure/EnvelopeSecretProtector.ts`
- `solutions/capabilities/cloud/identity/infrastructure/ServiceAssertions.ts`
- `solutions/capabilities/cloud/worker/` and `solutions/capabilities/cloud/orchestration/`
- the legacy `wk_` worker-token routes in `products/carbon-cloud/infrastructure/http/routes.ts`

Keep `dc_`, `cs_`, `ce_`, `pt_` and future worker tokens as distinct credential
types and audiences. Database and Registry each have their own exchange
contract and route; add a new one per audience instead of widening an existing
one. Legacy `wk_` worker tokens are outside the `CARBON_LEGACY_TOKENS` policy
and should move to enrolled worker credentials in this phase.

Phase 4 should add worker enrollment, lease-scoped worker credentials, a hosted
KMS/HSM custody adapter and short-lived build/function secret materialization.
Its proof gate must show that a worker can obtain only its leased inputs, that
browser and data routes cannot materialize secrets, and that expiry,
cancellation, replay, key rotation and worker loss are handled. Stop after its
tests and documentation; do not pull build execution or frontend work into that
phase.

## Verification baseline

From the repository root in PowerShell:

```powershell
$env:CARBON_PLATFORM_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55439/carbon_platform_test'
$env:CARBON_SERVICE_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55440/carbon_service_test'

bun.cmd test ./solutions/contracts/platform ./solutions/capabilities/cloud/identity/tests ./solutions/capabilities/cloud/catalog/tests ./solutions/capabilities/cloud/data/tests ./products/carbon-cloud/tests/platform/account-auth.integration.test.ts ./products/carbon-cli/tests/device-authorization.test.ts ./products/carbon-cli/tests/db.command.test.ts ./products/carbon-cli/tests/registry.test.ts ./.tools/automation/testing/platform-lifecycle.integration.test.ts --timeout 60000
bun.cmd .tools/automation/contracts/generate-platform-types.ts --check
bun.cmd x tsc --noEmit -p solutions/tsconfig.json
bun.cmd x tsc --noEmit -p products/carbon-cloud/tsconfig.json
bun.cmd x tsc --noEmit -p products/carbon-cli/tsconfig.json
```

Run focused tests while implementing, then the affected regression and affected
Bazel targets once. Record exact non-overlapping counts in
[platform-backend-progress.md](../platform-backend-progress.md). The worktree
contains substantial pre-existing uncommitted and untracked work across other
products; preserve it and scope reviews to the phase being changed.

At the end of every phase:

1. Add a dated entry to the progress log with the capability boundary and exact
   test evidence.
2. Update [left-off.md](left-off.md) so it names the newly completed phase and
   the next phase.
3. Update this document only when dependencies or phase boundaries change.
4. Stop at the checkpoint and report the remaining phase number.
