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
| 15 — partly complete | Implement BE-12 project plugin consumption and the remaining CLI workflows. | Done and proven against the real Registry: a declaration and an exact lock, add, install, update, remove and audit with pinned trust, capability approval, ABI and target compatibility, offline install and recovery from interruptions. Not built: loading an installed package in an app (G-126), Cloud's project plugin API and source proposals (G-127), and the remaining CLI workflows (G-128). The gate's "project APIs" half is not met. |
| 16 — partly complete | Implement BE-13 billing, quotas, operator boundaries, recovery, deletion and unknown-outcome resolution. | Done and proven: signed provider events applied once and in the provider's order through every subscription state; charged work admitted under one count per organization with budgets and unique metering; operator accounts with roles, reasons, a permanent record and two-person early deletion; legal holds and live subscriptions stopping final deletion. Not built: backup and restore (G-135). Never run against the real provider (G-136); unknown outcomes are kept, not resolved (G-138). |
| 17 — partly complete | Complete production browser adapters and the Carbon frontend one vertical slice at a time. | Done and proven for the first part: a production composition with no mock module in it, enforced by the build and by a test; live adapters for accounts, organizations, members, invitations, projects and environments, walked against the real API; Cloud serving the built console. Not done: every other area of the console (G-147), parts of the connected one (G-148), anything in a real browser (G-151). |
| 18 — partly complete | Complete observability, deployment compatibility, security review, migration reconciliation, canary rollout and cutover. | **Gate not met:** there is no deployment, so no production evidence exists (G-154). Done and proven on a development machine: liveness, readiness and metrics endpoints on all three services, request logs that carry routes and no values, read-only migration status and migrations as a separate release step, and rotation of Registry's signing key, the message key and the webhook secret. Written, not exercised: runbooks, the security checklist as a self-review, the cutover plan. Not done: restore drill (G-135), version-skew tests (G-158), threat model and independent review (G-159), canary cohorts (G-162). |
| 19 | Close the gap ledger: every open decision and everything an earlier phase could not finish or prove. | Each entry in [gaps.md](gaps.md) is closed with evidence or explicitly accepted by the owner. Includes the hardware- and account-dependent proofs (a real Windows build, signing, isolation, real KMS, a real identity provider) and CI running the database suites. |

## Continue Phase 19

Phases 1 to 7, 9, 11, 12 and 14 are complete; Phases 8, 10, 13, 15, 16, 17 and 18 are partly complete.
Phase 19 is the gap ledger itself, and it is under way: the progress log's Phase 19 entry lists what has been closed. Read these first:

- [gaps.md](gaps.md), all of it. It is the work list
- [cutover.md](../cutover.md), "Before any customer data": the order in which the outside dependencies matter
- [security-review.md](../security-review.md): which checklist items are not met
- [operations.md](../operations.md): what a deployment would be given to run

The ledger falls into three kinds of work:

- **Can be done in the repository now.** The largest is the rest of the console (G-147, G-148, G-150). Also: function logs and schedules (G-101, G-102), Cloud's project plugin API and the remaining CLI workflows (G-127, G-128), unknown-outcome resolution (G-138), process-level tests of the entrypoints (G-145, G-163), observing the legacy routes and workers (G-157), and removing legacy paths once nothing depends on them.
- **Needs something from outside.** A deployment (G-03, G-154), a database in CI (G-50), a Windows host with packaging tools and a signing certificate (G-36, G-37), an isolation mechanism for builds and functions (G-38, G-100), real AWS KMS, a real identity provider and the real payment provider (G-01, G-136), and an independent reviewer (G-159).
- **Needs the owner's decision.** Every such question is in [decisions.md](../decisions.md) with the default in force. "Keep" closes one.

Suggested order for what can be done in the repository: the CLI commands over the credential routes (G-128); the rest of the console (G-147); table deletion, schema changes as jobs, promotion and restricted SQL (G-64 to G-67); backup and restore (G-135); removal of Cloud's own rows at final deletion (G-09); owning-service and account events in the organization log (G-17, G-21); the cleanup sweeps (G-47, G-62, G-73, G-83, G-121, G-132); general rate limiting (G-18, G-60, G-80); then the legacy paths.

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
