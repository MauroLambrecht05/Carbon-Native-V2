# Carbon platform implementation handoff

Checkpoint: 2026-09-13. The user asked to stop Astra at a clean checkpoint and
leave the remaining work for another model. Do not interpret the older instruction
to continue indefinitely as permission to ignore this stop. Resume implementation
only under the user's next instruction.

Phase 1 is complete; Phase 2 (Registry assertion exchange) is next. The current
continuation documents are the concise
[left-off checkpoint](left-off/left-off.md) and the
[phase-by-phase handoff](left-off/handoff.md). Use one handoff phase per future
goal; this older document retains the detailed historical context.

## Objective and honest status

Implement the entire [backend plan](platform-backend-plan.md) across Carbon Cloud,
Database, Registry, CLI and updater, preserving an explicitly separate mock mode.
Use real provider adapters with environment configuration and no HTTP-to-mock
fallback. After backend completion, build a polished Supabase-inspired frontend
using Carbon colors and connect all working features. The companion
[frontend plan](platform-frontend-plan.md) defines required walkthroughs.

Estimate communicated to the user after the repository and device slices:
approximately **30% of the full goal**, about **40% of backend foundations**, and
**0% of the requested new frontend redesign**.
These are rough scope estimates, not measured completion percentages or release
readiness claims. The existing extensive mock frontend is not production parity.

The full goal is unfinished. No production deployment or customer cutover has
been completed. Do not mark the overall objective complete from this checkpoint.
The original plan's model recommendations do not require Astra; the user wants
to continue with a less expensive model.

## Read these first

1. This handoff, then the backend plan's sections 7-20 and 24-29.
2. [Implementation evidence](platform-backend-progress.md). It is chronological;
   older paragraphs saying a feature is unfinished may be superseded by later
   entries. It is not a substitute for the full specification.
3. [Account authentication](account-authentication.md),
   [catalog/provisioning](catalog-provisioning.md),
   [service lifecycle](service-lifecycle.md), [account data](account-data.md),
   [native data](native-data.md), [durable imports](data-imports.md),
   [environment credentials](environment-credentials.md),
   [environment secrets](environment-secrets.md),
   [GitHub repositories](github-repositories.md), and
   [device authorization](device-authorization.md).
4. Relevant code and tests for the next bounded feature, rather than rediscovering
   every existing capability or rewriting completed foundations.

## Working features and their boundaries

| Area | Implemented and tested | Important remaining boundary |
|---|---|---|
| Contracts | Shared JSON Schema 2020-12, generated TypeScript, strict Ajv validation, conformance fixtures, safe wire types | Add new DTOs here; complete all future service/CLI/updater contracts |
| Human identity | Email registration/verification/login/recovery, opaque cookie sessions, CSRF, fresh authentication, session management, profile/email change, TOTP MFA and recovery codes | Production browser wiring, stream revocation UX and hosted deployment evidence |
| GitHub account identity | Actual authorization-code/PKCE adapter, verified immutable subject, explicit linking/unlinking, MFA-aware account flows | This is account login, not GitHub App repository integration |
| Organizations | Creation, memberships, project assignments, scoped grants/expiry, invitations/resend/cancel/accept, ownership transfer, last-owner rules, MFA policy | General audit/event stream and production UI integration |
| Service authority | Ed25519 audience/request/scope-bound assertions, replay store, pinned trust, live Cloud permission/session checks | Apply this boundary to every future service surface and principal type |
| Catalog | Canonical projects/environments, independent Database/Registry bindings, durable provisioning steps, leases, retries, cancellation, status and pause/resume | Full archive/deletion/recovery and broad operation/event parity |
| Database isolation | Native environment roles/schemas, restricted generated DML, forced RLS, explicit owner/public-read rules, old/new row checks | Raw SQL remains a separate unsafe legacy path; restricted SQL is unfinished |
| Relational data | Catalog/details, exact typed values/defaults, keyset pagination, filters/sorts/projections/JSON paths/selected IDs, optimistic CRUD and command receipts | App-realm authentication and unrestricted administrative data mode |
| Schema management | Rename/add/edit/drop columns, user keys, managed unique/check/index constraints, previews, generated TypeScript | Foreign-key management, full dependency-impact preview, large asynchronous schema work, migration promotion |
| Imports | Structural CSV/JSON review, native atomic/partial execution, conflict modes, encrypted Cloud queue, leased signed dispatch, status, cancellation and receipt recovery | Large uploads, operator resolution/retention of unknown outcomes and private exports |
| Credentials | Exact-scope environment, device and managed service-account credentials; one-time disclosure, hash-only persistence, bounded expiry/rotation, revocation, safe audit, live verification, Database assertion exchange, and CLI device login/logout plus canonical Database commands using OS secure credential storage | Personal/worker credentials, Registry exchange, automated row-policy semantics and legacy migration |
| Environment secrets | Immutable encrypted versions, per-version data keys, replaceable wrapping-key custody, metadata-only create/list/rotate/disable routes and safe audit | Hosted KMS/HSM adapter, build/function lease authorization, short-lived materialized bindings and retention/destruction policy |
| GitHub repositories | GitHub App JWT and ephemeral installation authorization, repository discovery, identifier-only persistence, project bindings, immutable SHA resolution, deterministic pull-request proposals, signed/deduplicated webhooks and installation/removal revocation | Production GitHub App and key-rotation evidence |
| Registry | Canonical namespace lifecycle and owning-service scope checks | Full publisher/review/trust/CLI production lifecycle remains open |

Existing legacy capabilities (build queue, Stripe, S3, Database vector/graph/blob/
function/realtime engines, Registry archives and updater implementations) are
useful starting points. Their presence does not satisfy the new scope, isolation,
durability, trust or end-to-end acceptance requirements automatically.

## Earlier completed slice: durable imports

This was the checkpoint implementation slice. It compiles and its real
HTTP/PostgreSQL tests pass. It adds Cloud migration `0015_data_import_jobs.sql`, with jobs,
attempts, cancellation receipts and safe events, separately from lifecycle-only
`operations` so the provisioning worker cannot claim import jobs.

Account routes live below
`/platform/v1/orgs/{orgId}/projects/{projectId}/environments/{environmentId}/data/imports`:

- POST base: `DataImportJobCreate`, returns 202 and `DataImportJobReceipt`.
- POST `/{operationId}/status`: `{}`, returns `DataImportJobView`.
- POST `/{operationId}/cancel`: `DataImportJobCancel`, returns 202 and a receipt.

All use Origin, cookie and CSRF. Enqueue requires fresh `data.write`. Polling and
cancellation require metadata access; cancellation also requires the creator or
an organization manager. Mutation headers bind command ID and revision.

`CARBON_DATA_IMPORTS=enabled` explicitly enables the capability. The worker runs
with `bun run --cwd products/carbon-cloud data-import-worker`. It uses the pinned
Database origin, assertion signing configuration, Cloud database and account
envelope keyring. It does not require email-provider credentials.

Database has a separate `/imports/{operationId}/execute|status` signed protocol.
Ordinary `DataRequest` and `AccountDataRequest` deliberately reject
`rows.import.apply`. Keep this separation: it prevents a browser from bypassing
job leases by invoking the native execution command through synchronous data API.

Recovery rules that must be preserved:

- Cloud stores encrypted source and a canonical intent digest. Database commits
  rows, audit counts and its existing command receipt in one transaction.
- Every reclaimed/interrupted lease first checks Database's receipt under the
  same advisory command lock used for execution. The replacement lease fences
  the old signed request. A null receipt permits retry or confirmed cancellation.
- A committed receipt settles success even if the response was lost or the user
  cancelled after the commit. Never report cancellation as proof of rollback
  without reconciliation.
- Live cancellation or permission loss before the final native authority check
  rolls back both atomic and partial imports entirely.
- Reconciliation may refresh the account permission revision for metadata-only
  access, but still requires the original session/security state. It cannot
  authorize a new write after write access or configuration changes.
- If receipt lookup cannot be authorized after possible dispatch, terminal state
  is `failed` with `outcomeUnknown: true`. Preserve this distinction from known
  rollback. Encrypted staging is retained for later operator review; operator
  resolution and retention cleanup are not implemented yet.
- Limits: 256 KiB source, 1,000 rows, 100 pending jobs/org, 45-second lease,
  20-second transport timeout, 5-second SQL timeout, 15-second native loop budget,
  15-minute job deadline, up to eight attempts eligible for execution plus a
  possible final reconciliation. Safe row error evidence is capped at 100.

Primary new/changed implementation files:

- `solutions/contracts/platform/data-import.ts`, schema and generated types.
- `solutions/capabilities/cloud/data/application/usecases/AccountImports.ts`,
  `ExecuteServiceImport.ts`, `RunImportJobs.ts` and `ports/ImportJobs.ts`.
- `solutions/capabilities/cloud/data/infrastructure/PostgresImportJobs.ts`,
  `HttpImportClient.ts`, `PostgresNativeTables.ts`, `NativeImportExecutor.ts`.
- `solutions/capabilities/cloud/catalog/infrastructure/PostgresServiceAuthority.ts`.
- `products/carbon-cloud/composition/account-platform.ts`, `data-platform.ts`,
  `data-import-worker.ts`, and `presentation/http/account-routes.ts`.
- `products/carbon-database/presentation/http/import-routes.ts` and
  `composition/lifecycle-platform.ts`.
- `.tools/automation/testing/platform-lifecycle.integration.test.ts` and
  `solutions/capabilities/cloud/data/tests/import-protocol.test.ts`.
- [Import runbook](data-imports.md) and [OpenAPI](data-import-api.openapi.json).

## Latest implementation slices: credentials and secrets

Cloud migrations `0016_environment_credentials.sql` and
`0017_environment_secrets.sql` add the first BE-05 foundations. The account API
now manages exact-environment automation credentials below `/credentials` and
versioned encrypted values below `/secrets`. Both surfaces require same-origin
cookie/CSRF authentication, current revisions, fresh `resources.configure`
authority and durable idempotency/audit evidence. Metadata lists require
`metadata.read`.

Environment credentials use distinct `ce_` tokens, one-time disclosure,
SHA-256-only persistence, explicit automation audience, bounded expiry and up to
24 hours of single-predecessor rotation overlap. The live verifier rejects wrong
scope/permission, expiry, revocation and inactive parents. See
[environment credentials](environment-credentials.md) and its
[OpenAPI](environment-credentials-api.openapi.json).

Environment secret versions use an independent random data key, AES-256-GCM
context binding and a replaceable `SecretKeyCustodian` wrapping-key port. The
explicit self-hosted keyring is separate from account/import keys and supports
read-old/write-new rotation. Account responses and durable safe evidence never
contain values, envelopes or wrapping-key identifiers. See
[environment secrets](environment-secrets.md) and its
[OpenAPI](environment-secrets-api.openapi.json). Hosted KMS/HSM custody and
lease-specific build/function materialization remain open.

## Latest implementation slice: GitHub App repositories

Cloud migration `0018_repository_integrations.sql` and the vendor-neutral
`RepositoryProvider` port add durable installation metadata, discovered
repositories, project bindings, command receipts, safe events, webhook delivery
digests and immutable commit-resolution evidence. The GitHub adapter signs
short-lived RS256 App JWTs and obtains ephemeral installation tokens for each
discovery, configuration refresh, resolution and webhook. No PAT, installation
token, App key, webhook secret or raw webhook body is persisted.

Account routes list/connect installations under `/repository-installations` and
read/save/clear one project binding under `/projects/{projectId}/repository`.
`/repository/resolve` converts a branch or tag to a lowercase 40-character SHA
before future build work. The external `/webhooks/github` route authenticates the
exact bounded body, delivery ID and event before parsing; duplicate deliveries
return the stored outcome and removed/archived repositories disconnect affected
projects. Browser mutations retain fresh authority, CSRF, current revisions and
durable idempotency. See [runbook](github-repositories.md) and
[OpenAPI](github-repository-api.openapi.json).

The proposal route derives a deterministic branch from actor and idempotency key,
then reconciles the branch, desired file content and existing pull request before
each provider write. A retry after process loss completes or reuses partial
GitHub state and stores one durable safe receipt. It never overwrites the
configured base branch and does not persist proposed source content.

## Remaining implementation backlog

### BE-01 to BE-03: finish broad integration without rebuilding the foundation

- Wire existing account/org/catalog APIs into production browser adapters when
  the backend-first sequence reaches frontend work.
- Add durable account/access/operation streams, immediate stream revocation,
  cross-product audit browsing and notification parity.
- Complete archive/deletion/suspension/recovery semantics and legacy migration
  windows; native provisioning alone does not complete catalog lifecycle.
- Extend the adversarial two-tenant matrix to every new surface. Existing raw SQL,
  storage, realtime and functions remain production blockers.

### BE-04: application authentication

- Canonical project/environment realms; app users, identities, challenges,
  sessions, events and provider configuration references.
- Realm signup policy, verified magic links/OIDC, redirect allowlists, rate limits,
  session rotation/revocation, suspension/deletion/export and public configuration.
- Verified app-audience assertions must supply Database policy context. Do not
  substitute dashboard policy-preview requests for actual app-user authentication.

### BE-05: repositories, credentials and secrets

- Gather production GitHub App installation, repository, proposal and key-rotation
  evidence; signed suspension/deletion deliveries already revoke access.
- Extend the completed environment, device and service-account credential
  foundations to personal and worker credentials, CLI command integration,
  Registry assertion exchange and legacy `cc_` migration/deprecation.
- Extend the completed versioned environment-secret foundation with hosted
  KMS/HSM custody, retention/destruction policy and lease-specific delivery to
  build/function workers. No browser or generic data route may materialize values.

### BE-06 and BE-07: Windows delivery

- Build snapshots and quota reservations; enrolled scoped workers, attempts,
  heartbeats, cancellation, durable ordered logs and verified immutable artifacts.
- Disposable Windows x64 execution, resource/egress limits, exact dependency locks,
  NSIS and optional WiX, signing and provenance.
- Releases, channel revisions, rollout/promotion/withdrawal and protected signing
  profiles; shared publisher/TypeScript/standalone/Rust updater conformance.
- Real Windows build, clean VM install/launch/update/uninstall and digest/signature
  evidence. Do not count the historical Linux build proof as this gate.

### BE-08 and BE-09: remaining data services

- Private export jobs with expiring authorized downloads, large imports if needed,
  saved queries, restricted asynchronous SQL, result expiry and redacted history.
- Foreign-key lifecycle, migration promotion, asynchronous large schema changes
  and complete dependency-impact reporting.
- Blob buckets/visibility/versioning/retention, constrained binary uploads and
  verified completion; private downloads and idempotent storage/egress metering.
- Canonical vector/graph authorization, bounded batches/traversals, dimensions,
  indexes, referential rules, quotas and cancellable large jobs.
- Durable transactional mutation outbox and authorized realtime replay/reconnect,
  per-event row visibility, deduplication and revocation closure.

### BE-10: isolated functions and schedules

- Immutable source/package/deployment snapshots and explicit invocation grants.
- Out-of-process isolated workers with resource/filesystem/egress limits, secret
  references, durable bounded logs/results, cancellation and retry semantics.
- Timezone/DST-aware schedules with overlap/missed-run policy and dedicated
  credentials. Existing in-process function execution is not production-safe.

### BE-11 and BE-12: Registry and CLI

- Publisher memberships/namespaces, draft/submission/validation/review/publish/
  deprecation/revocation states and immutable review evidence.
- Quarantined uploads, safe bounded archive inspection, target/ABI/capability
  validation and actual loader-compatible Windows fixtures.
- Persistent signing and independently distributed pinned trust bundles with
  rotation/revocation history. Never establish trust from the archive response.
- Exact committed dependency locks, grant approval/source proposals, verified
  extraction/staging/provenance and narrow CLI account/device credentials.
- Full CLI org/project/environment/build/log/artifact/release/channel workflows,
  while preserving offline local plugin development.

### BE-13: billing, operators and recovery

- Signed idempotent payment event inbox, subscription/invoice projection, unique
  usage events, quota reservations/settlement and budgets.
- Separate operator identity/roles, reasoned audited actions and protected trust/
  destructive workflows; no default customer impersonation.
- Backup manifests across all data categories, restore into a new/reviewed target,
  partial recovery, retention, legal holds and reversible scheduled deletion.
- Explicit reconciliation of import `outcomeUnknown` and staging retention.

### Production browser, deployment and final gates

- Complete real adapters for every frontend service; preserve mock mode as a
  separate composition and prove production bundles exclude mock imports/data.
- Then build the requested Supabase-inspired Carbon frontend and pass every
  frontend-plan walkthrough against real services, including errors and recovery.
- Readiness, structured redacted logs, metrics/traces/alerts, provider outage and
  disaster-recovery runbooks, key rotation and N/N-1 deployment compatibility.
- Legacy ownership migration/reconciliation, canary rollout, security review,
  backup restore and production cutover. No mock fallback during rollback.

## Suggested next bounded task

Continue with Phase 1 in [the phase-by-phase handoff](left-off/handoff.md): make
the CLI consume the completed device flow and request exact downstream
assertions. Keep each later phase as a separate goal and stop after its proof gate.

Before production use of imports, add operator resolution/retention for unknown
outcomes. A follow-up hardening pass can cover a truly concurrent old in-flight
execution during lease reclamation, full retry/deadline exhaustion and source-key
loss; the checkpoint tests cover lost committed replies, stale old leases,
cancellation at final authorization, permission revocation and session revocation.
These additional drills have not been claimed as already verified.

## Verification and local environment

Workspace: `C:\Users\mauro\Desktop\carbon-native\V2`, Windows PowerShell, Bun
1.3.10. Use `login:false` with shell tools. No app/provider production credentials
were requested or installed for this checkpoint.

Docker Desktop's `desktop-linux` context has dedicated disposable test services:

- `carbon-platform-test-postgres`, PostgreSQL 16, port 55439.
- `carbon-service-test-postgres`, pgvector/PostgreSQL 16, port 55440.

They were left running. Integration harnesses create private random databases and
delete only their own databases and generated `ce_<32 hex>` roles. Never point
them at a customer database; they require the exact base database names below.

```powershell
$env:CARBON_PLATFORM_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55439/carbon_platform_test'
$env:CARBON_SERVICE_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55440/carbon_service_test'

bun test ./solutions/contracts/platform ./solutions/capabilities/cloud/identity/tests ./solutions/capabilities/cloud/catalog/tests ./solutions/capabilities/cloud/data/tests ./solutions/integrations/identity/github ./solutions/integrations/notification/resend ./products/carbon-cloud/tests/platform ./products/carbon-database/tests ./.tools/automation/testing/platform-lifecycle.integration.test.ts
bun test ./.tools/automation/testing/platform-service-migrations.integration.test.ts
bun x tsc --noEmit -p solutions/tsconfig.json
```

Latest checkpoint results: the selected suite passed **166 tests, 0 failures,
2,657 assertions across 22 files**. Separate owning-service migration tests passed
**2 tests, 18 assertions**. The protocol-only run passed **3 tests, 40 assertions**
(also included in the 166). Solutions TypeScript passes. Do not add overlapping
runs when reporting a unique test count. Historical 286-test evidence in the
progress log refers to a different broader selection; it is not this run's count.

The final Bazel and documentation validation results are recorded in the last
entry of [implementation evidence](platform-backend-progress.md).

Latest BE-05 affected evidence: **103 tests, 0 failures and 1,929 assertions
across 13 files**. The focused service-account path accounts for **37 PostgreSQL
assertions**. All **15 affected Bazel targets** passed, including workspace
TypeScript, generated contracts, conformance, identity, catalog, data and account
HTTP wiring. This affected run overlaps the older checkpoint selections.

Useful focused commands:

```powershell
bun test ./.tools/automation/testing/platform-lifecycle.integration.test.ts -t 'durable import API|import workers reconcile|import cancellation'
bun test ./solutions/capabilities/cloud/data/tests/import-protocol.test.ts
bun test ./products/carbon-cloud/tests/platform/account-auth.integration.test.ts -t 'device authorization approves'
bazel test //.tools/validation:typescript_test //.tools/automation/contracts:platform_types_test //solutions/contracts/platform:conformance_test //solutions/capabilities/cloud/data:import_protocol_test
```

## Workspace and tooling cautions

- The working tree contains extensive pre-existing/uncommitted/untracked work,
  including Discord, website, mock frontend and backend source. No checkpoint
  commit was created. Do not reset, clean, bulk-stage or revert the tree. Inspect
  only relevant changes and preserve the user's other work.
- Some source is ignored or untracked. `git diff` alone is not a complete inventory.
  Read the files and include new files deliberately when eventually committing.
- The canonical contract is `solutions/contracts/platform/schema/platform.schema.json`.
  Generate types with `.tools/automation/contracts/generate-platform-types.ts` and
  keep typed conformance fixtures covering every `$defs` component. The generator
  supports `anyOf`; do not introduce unsupported `oneOf` without extending it.
- Intermittent sandbox access failures resolving linked `ajv/dist/2020.js` and
  `ajv-formats` have occurred. Rerun the important check with normal escalation;
  do not remove validators or rewrite dependencies as a workaround.
- Bun 1.3.10 SQL rejection matchers can hang on repeated rollbacks. Integration
  tests use explicit try/catch rejection helpers for PostgreSQL promises.
- Use `rg` for searches, explicit Windows paths and native PowerShell file
  operations. Do not use shell-glob path arguments that PowerShell leaves literal.
- Database environment `SET ROLE` protects generated DML, not arbitrary SQL from
  a privileged connection. Do not expose raw SQL through that adapter.
- Local legacy RLS fixes do not make process-local realtime or in-process
  functions production-ready. These remain explicit cutover blockers.
- There were earlier workspace-wide structural violations in unrelated local
  caches/toolchains/editor directories/design assets. Do not claim the entire
  `bazel test //...` workspace is green from scoped tests or delete these assets.
- No subagents were used in this checkpoint. Follow the next session's actual
  delegation permissions, not historical model recommendations in the plan.
- Avoid repeating already-passing broad tests after documentation-only edits.
  Verify meaningful changes, report evidence and remaining gaps, and keep the
  next model's tasks bounded to reduce cost.
