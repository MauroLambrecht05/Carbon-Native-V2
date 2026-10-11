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
| 8 — partly complete | Implement disposable Windows x64 execution, dependency locks, NSIS/WiX packaging, signing and provenance. | Done and proven: Cloud verifies declared artifacts against object storage, signed provenance, a worker runtime with pinned checkout, required lockfile, log redaction, disposable workspace and cancellation. Not proven: a real NSIS/WiX build, Authenticode signing, and resource or egress limits (G-36 to G-38). The gate is not met until those are. |
| 9 — complete | Implement BE-07 releases, channel revisions, rollout/promotion/withdrawal and updater compatibility. | Completed: immutable releases over verified artifacts, signing profiles, signed channel revisions, promotion, rollout, withdrawal with a stop list, a public feed, and one conformance fixture run by the publisher's code and the TypeScript, standalone and Rust updaters. No packaged app has updated from the feed yet (G-57). |
| 10 — partly complete | Finish BE-08 relational work: private exports, foreign keys, impact previews, asynchronous schema work, migration promotion and restricted SQL. | Done and proven against real Database: foreign keys, cross-table impact previews, and private resumable exports with authorization, cancellation and crash recovery. Not built: restricted SQL, migration promotion, asynchronous schema changes, table deletion (G-64 to G-67). |
| 11 — complete | Implement BE-09 blob storage with private objects, signed bounded transfers, metadata authority, retention and cleanup. | Completed: buckets, single-use exact-object transfers verified before storing, public download by current visibility, versions and retention, quota, cleanup and metering, proven across two environments over real HTTP. App users have no blob access yet (G-76); transfers are mediated by Database, not presigned (G-78). |
| 12 — complete | Implement BE-09 vector, graph and realtime parity with canonical environment authority and durable outbox semantics. | Completed: a database-captured change feed read in commit order under row policy with a resumable stream; vector collections with exact deterministic search; a bounded property graph; exact-scope isolation and reconnect, replay and revocation proven. Events carry no row values (G-88); the stream is polled and account-only (G-90); vector search has no index (G-94). |
| 13 — partly complete | Implement BE-10 functions and schedules with immutable revisions, secret bindings, leases, limits and durable executions. | Gate met: deploy, invoke, schedule, cancel and retry tests prove revision pinning, secret isolation, idempotency and timeout recovery, and a real worker process runs leased code. Not built from the plan's section 16: isolation and resource limits (G-100), logs (G-102), calendar schedules (G-101), app and service invocation (G-104), drafts, packaging and promotion (G-105). |
| 14 — complete | Implement BE-11 Registry publisher identity, review, trust, immutable archives, yanking and signed distribution. | Completed: organization-owned publisher names, exact uploads inspected into quarantine, operator review with permanent records, signed statements under a root-signed trust bundle, yanking, security revocation and public distribution, proven from publish to verified install across two tenants over real HTTP. Nothing installs from it yet (G-116); operators are names, not accounts (G-114); keys are not in a KMS (G-115); binaries are checked by header only (G-117). |
| 15 | Implement BE-12 project plugin consumption and the remaining CLI workflows. | Lockfile, install/update/remove, compatibility and offline/error recovery pass against real Registry and project APIs. |
| 16 | Implement BE-13 billing, quotas, operator boundaries, recovery, deletion and unknown-outcome resolution. | Provider webhook replay, quota races, operator audit, backup/restore and irreversible-deletion gates pass. |
| 17 | Complete production browser adapters and the Carbon frontend one vertical slice at a time. | Each frontend-plan walkthrough passes against real services; production bundles contain no mock imports or mock data. |
| 18 | Complete observability, deployment compatibility, security review, migration reconciliation, canary rollout and cutover. | Sections 25-29 of the backend plan have recorded production evidence, including restore, rotation, rollback and no-mock-fallback drills. |
| 19 | Close the gap ledger: every open decision and everything an earlier phase could not finish or prove. | Each entry in [gaps.md](gaps.md) is closed with evidence or explicitly accepted by the owner. Includes the hardware- and account-dependent proofs (a real Windows build, signing, isolation, real KMS, a real identity provider) and CI running the database suites. |

## Start with Phase 15

Phases 1 to 7, 9, 11, 12 and 14 are complete; Phases 8, 10 and 13 are partly complete.
Read these files before changing Phase 15 code:

- section 18 of [the backend plan](../platform-backend-plan.md), "BE-12: plugin consumption and CLI changes", and its proof gate
- [registry-publishing.md](../registry-publishing.md): what Registry serves and exactly what an installer must check (`verifyRegistryPackage`, `packArchive`, `inspectArchive` in `@carbon/catalog`)
- `products/carbon-cli/presentation/commands/plugins/plugin.command.ts` and `products/carbon-cli/composition/registry.ts`: the commands as they are, still on the legacy API (G-116)
- `products/carbon-cli/infrastructure/cloud/RegistryDeviceClient.ts`: the CLI's signed path to Registry, which so far sends only `namespace.get` (G-122)
- `solutions/capabilities/plugin/lifecycle` and `solutions/capabilities/plugin/trust`: local plugin builds and the loader's older signature scheme
- [github-repositories.md](../github-repositories.md): source proposals, the way a lock file reaches a repository

Phase 15 builds plugin consumption: an exact lock file, install, update and
remove against the canonical Registry with pinned trust, and the remaining CLI
workflows.

## Deferred work

Open decisions and everything a phase could not finish or prove are not worked
as they come up. They are recorded in [gaps.md](gaps.md), a default is chosen
where one is needed to keep going, and all of it is worked in Phase 19. What
Phase 8 still needs (a Windows host with NSIS and WiX, a signing certificate,
and build isolation) is there as G-36 to G-38.

## Verification baseline

From the repository root in PowerShell:

```powershell
$env:CARBON_PLATFORM_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55439/carbon_platform_test'
$env:CARBON_SERVICE_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55440/carbon_service_test'

bun.cmd test ./solutions/contracts/platform ./solutions/capabilities/cloud/identity/tests ./solutions/capabilities/cloud/catalog/tests ./solutions/capabilities/cloud/data/tests ./solutions/capabilities/cloud/worker ./solutions/capabilities/distribution/updating ./products/carbon-updater ./products/carbon-cloud/tests/platform/account-auth.integration.test.ts ./products/carbon-cli/tests/device-authorization.test.ts ./products/carbon-cli/tests/db.command.test.ts ./products/carbon-cli/tests/registry.test.ts ./.tools/automation/testing/platform-lifecycle.integration.test.ts --timeout 60000
bun.cmd .tools/automation/contracts/generate-platform-types.ts --check
bun.cmd .tools/automation/contracts/generate-update-conformance.ts --check
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
