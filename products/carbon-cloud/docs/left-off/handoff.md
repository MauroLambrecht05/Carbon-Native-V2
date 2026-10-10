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
| 4 — complete | Add worker enrollment, lease-scoped worker credentials, hosted KMS/HSM custody, and short-lived build/function secret materialization. | Completed: `we_`/`wc_`/`wl_` credentials, leases granted only inside Cloud, single-use lease-bound secret delivery, sweeper, AWS KMS adapter; expiry, cancellation, replay, rotation and worker loss are tested. Not run against real AWS. |
| 5 — complete | Finish BE-01 to BE-03 lifecycle gaps: streams, audit browsing, archive/deletion/suspension/recovery, revocation propagation and adversarial tenant coverage. | Completed: unified event log, audit listing and SSE stream, scheduled recoverable deletion for environments, projects and organizations, operator suspension, credential revocation matrix, and a 69-case two-tenant denial matrix. |
| 6 — complete | Implement BE-04 application authentication realms, app users, identities, providers, challenges and sessions. | Completed: realm per environment, generic single-use magic links, OIDC with PKCE and verified ID tokens, exact redirect allowlist, rate limits, session rotation and revocation, and app-user Database row access proven end to end. |
| 7 — complete | Implement BE-06 build orchestration: immutable source snapshots, quota reservations, attempts, leases, heartbeats, cancellation and ordered logs. | Completed: builds on worker leases with an immutable digested input, serialized quota reservation, attempts with lost-worker retry, gapless append-only logs, immutable artifact declarations, cancellation and deadlines, all proven durably. Artifact verification and a worker runtime are Phase 8 (G-27, G-35). |
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

## Start with Phase 8

Phases 1 to 7 are complete. Read these files before changing Phase 8 code:

- section 12 of [the backend plan](../platform-backend-plan.md), "Execution" and its proof gate
- [builds.md](../builds.md) and [workers.md](../workers.md): the protocol a worker must speak
- [gaps.md](gaps.md), entries G-27 to G-35: what Phase 7 left for this phase
- `solutions/capabilities/cloud/worker/` (the legacy worker runtime: `RealLocalPipeline`, `GitRepoFetcher`, `S3ArtifactUploader`)
- `solutions/capabilities/distribution/` (packaging, signing, publishing)
- `solutions/capabilities/cloud/orchestration/application/usecases/PlatformBuilds.ts`

Phase 8 makes a build real: a worker runtime that enrolls, claims a build lease,
fetches the exact commit, locks dependencies, compiles, packages NSIS and WiX,
signs where configured, uploads, declares artifacts with provenance, and erases
its workspace and secrets. Cloud must verify declared objects and digests before
accepting success (G-27), and the build input should grow into the full snapshot
(G-28, G-29).

Its proof gate needs a clean Windows worker building a pinned commit under
resource and egress limits and emitting verified immutable artifacts and
provenance. That needs a Windows build host with the toolchain, and a signing
certificate for the Authenticode part: record what could not be proven on the
available machine in the gap ledger rather than claiming it.

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
3. Add every gap the phase leaves to [gaps.md](gaps.md), and move the ones it
   closed to the closed table.
4. Update this document only when dependencies or phase boundaries change.
5. Stop at the checkpoint and report the remaining phase number.
