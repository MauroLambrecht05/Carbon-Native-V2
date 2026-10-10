# Carbon Cloud: Full Platform Backend and Mock-to-Production Plan

Status: implementation specification for replacing the unified platform frontend's mock adapters with production services.

Prepared: 2026-09-12.

Companion specification: [platform-frontend-plan.md](platform-frontend-plan.md).

## 1. Purpose and completion boundary

This plan takes the completed mock frontend through real backend implementation, cross-product integration, migration, deployment, and production cutover. It covers Carbon Cloud, Carbon Database, Carbon Registry, Carbon CLI, Carbon Updater, shared solution capabilities, and shared contracts.

The work is complete only when the production browser composition contains no mock service, no silent HTTP-to-mock fallback, and every visible action either performs an authorized durable operation or returns an explicit capability/error response. Mock mode remains separately runnable for demos and contract development.

The production outcome is one control plane in which a human can:

1. Register and verify a Carbon account, manage sessions and MFA, join organizations, and receive scoped access.
2. Create a project and isolated development, staging, and production environments.
3. Connect a source repository, manage configuration and secrets, and create narrowly scoped automation credentials.
4. Build a Windows x64 application on managed or organization workers, follow durable logs, and download immutable artifacts.
5. Publish signed releases, move update-channel pointers, control rollout, and withdraw unsafe versions.
6. Manage relational data, app identities, blobs, vectors, graphs, realtime subscriptions, migrations, backups, and functions.
7. Publish and consume validated plugins using persistent trust anchors and exact dependency locks.
8. View real usage, subscriptions, invoices, budgets, quotas, audit history, and recoverable deletion state.
9. Operate provisioning, workers, trust, Registry review, suspension, and recovery through a separately authorized operator surface.

## 2. Non-goals and fixed boundaries

- Do not add a fourth platform backend or a generic gateway product. Carbon Cloud is the account-facing control plane and same-origin browser API.
- Do not merge Carbon Database or Carbon Registry into Cloud. They remain independently deployable owners of their resources.
- Do not expose Cloud database credentials, service credentials, signing keys, provider secrets, or stored secret values to the browser.
- Do not forward a browser cookie as a service credential. Cross-service calls use audience-bound internal assertions.
- Do not make `search_path` the database tenancy boundary.
- Do not execute functions inside the Database HTTP process.
- Do not fetch a Registry signing key from the same untrusted response as package bytes and treat that as trust establishment.
- Do not claim general Supabase/PostgREST compatibility. Publish the supported Carbon query contract.
- Do not add macOS/Linux desktop delivery to this program. Windows x64 with NSIS and optional MSI/WiX is the production target.
- Do not modify updater behavior beyond the compatibility work required for the documented release contract.
- Do not delete the stateful mock system after production cutover.

## 3. Current repository baseline

### 3.1 Carbon Cloud

Implemented today:

- Organization creation and organization/worker bearer tokens.
- Token verification used by Database and Registry.
- Organization-scoped application-user magic links and sessions.
- A Postgres build queue, worker claim/completion, basic logs/artifacts, build-minute metering, and Stripe Checkout/webhook integration.
- Linux worker execution verified through a real `.deb` build and S3-compatible upload/download.

Production gaps:

- No human account model, memberships, invitations, MFA, scoped grants, browser sessions, or service-account lifecycle.
- No canonical Cloud project/environment catalog.
- Builds are organization/repository/commit records rather than project/environment/configuration snapshots.
- Logs and artifact browsing include process-local state.
- No complete operation, audit, notification, quota, retention, or operator model.
- No project-scoped release/channel API.
- Windows worker, signing, installer launch, and updater round trip are not proven on a real Windows host.

### 3.2 Carbon Database

Implemented today:

- Postgres catalog and project schemas, dynamic tables, basic data mutations, raw SQL, pgvector, graph storage, storage metadata/S3 bytes, migrations/snapshots, in-process realtime, Postgres-backed policies, and in-process function execution.
- Identity verification delegated to Carbon Cloud.

Production gaps:

- Database creates its own project rows instead of consuming Cloud's canonical catalog.
- Several routes authenticate a token without proving the requested project belongs to the verified principal.
- Raw SQL uses `search_path` but lacks a hard database-role/schema isolation boundary.
- Unknown policy expressions can fail open; policy enforcement is incomplete for old/new row values.
- Public storage download does not consistently enforce bucket visibility and policy.
- Realtime is process-local and does not provide durable authorized replay/reconnect semantics.
- Function execution is not isolated, revisioned, scheduled, resource-limited, or secret-reference based.
- Snapshot/import is not a bounded asynchronous recovery operation with a complete manifest.

### 3.3 Carbon Registry

Implemented today:

- Postgres metadata, S3-compatible archive storage, validation, Ed25519 signatures, public search/detail/download, Cloud token verification, and CLI consumption.

Production gaps:

- No publisher namespaces, scoped publishing grants, draft/review lifecycle, deprecation/withdrawal, or durable review evidence.
- Standard packages may be fixtures rather than loader-compatible Windows archives.
- The signing key can be ephemeral and trust establishment is coupled to the archive service.
- No key rotation/revocation history or independent trust bundle.
- CLI installation does not yet implement the complete exact-lock/extraction/staging/provenance contract.

### 3.4 Carbon CLI and Updater

- CLI has separate Cloud, Database, release, and Registry flows and persists broad tokens.
- Updater paths exist in TypeScript, the standalone updater product, and the Rust runtime. Their producer/consumer compatibility must be proven together.
- The production platform must not assume that every updater path implements every rollback, recall, restart, or health-reporting behavior exposed by the mock.

## 4. Target topology and trust boundaries

```text
Browser
  | HTTPS, Secure/HttpOnly/SameSite session cookie, CSRF token
  v
Carbon Cloud platform API (same origin)
  |-- Cloud Postgres: accounts, orgs, catalog, configuration, operations,
  |   builds, releases, billing, audit, operator metadata
  |-- object storage: build/release artifacts and exports
  |-- repository provider APIs through provider installations
  |-- payment/email providers through explicit ports
  |
  | short-lived signed internal assertion, exact audience and scope
  +--> Carbon Database API --> Database Postgres + object storage + workers
  +--> Carbon Registry API --> Registry Postgres + object storage + trust signer
  +--> Windows worker API --> isolated build workers

Installed Carbon application
  |-- public signed update manifest/artifact endpoints
  |-- app-realm public auth/data/function endpoints
  +-- updater reports only documented, consented telemetry
```

### 4.1 Browser boundary

- Production UI and API are same-origin under Carbon Cloud.
- Browser authentication uses an opaque server session cookie. No long-lived bearer token is stored in localStorage.
- State-changing requests require same-origin checks and a session-bound CSRF token.
- Content Security Policy allows only the production Cloud API origin plus deliberately configured identity-provider navigation. It never permits arbitrary service origins.
- Carbon Cloud exposes explicit platform routes; it is not a byte-for-byte open proxy to Database or Registry.

### 4.2 Service boundary

Cloud signs a short-lived internal assertion for each downstream call containing:

- `iss`, `aud`, `sub`, `jti`, `iat`, `nbf`, and `exp`.
- Principal kind and audience: account, service account, app user, worker, or operator.
- Organization, project, environment, realm, roles, and effective grants.
- The originating session/credential ID and correlation ID.
- A permission-set revision so revoked access can be rejected promptly.

Database and Registry validate signature, issuer, audience, expiry, replay policy, and resource binding locally. They never accept organization/project/environment identifiers solely because the caller supplied them. Key discovery uses a pinned Cloud issuer configuration with rotation overlap.

Long-running work captures an authorization snapshot for audit but rechecks live authority before committing sensitive results. Scheduled work runs as an explicitly provisioned service principal rather than a human browser session.

### 4.3 Source of truth

| Subject | Authority |
|---|---|
| Human accounts, sessions, organizations, memberships, grants | Carbon Cloud |
| Canonical project/environment IDs and service bindings | Carbon Cloud |
| Repository/configuration revisions | Carbon Cloud plus immutable source commit |
| Build/release/channel state and usage attribution | Carbon Cloud |
| Tables, rows, policies, blobs, vector/graph resources, functions, migrations, backups | Carbon Database |
| App-user identities and sessions | Existing Cloud auth capability, realm-scoped; Database consumes claims |
| Publisher/package/version/review/trust metadata and package bytes | Carbon Registry |
| Plugin dependency intent | Source repository |
| Resolved plugin lock and build provenance | Cloud build snapshot plus source lock |
| Subscription/invoice provider truth | Payment provider; Cloud stores reconciled projection |
| Audit record | The service that accepted the mutation; Cloud aggregates safe projections |

## 5. Shared contract program

Create `solutions/contracts/platform/` because the production browser, Cloud, Database, Registry, CLI, and workers must agree on these wire and stored forms.

The package contains:

- JSON Schema or OpenAPI component definitions for IDs, scope, principals, permissions, errors, pages, revisions, commands, receipts, operations, audit records, events, and capability flags.
- TypeScript types generated or validated from the schemas.
- A compatibility README defining additive vs. breaking changes, deprecation windows, and media-type/version rules.
- Conformance fixtures consumed by all three service products and the production browser adapter.
- Redaction metadata for fields that must never be logged or returned after creation.

Promote the existing product-owned mock DTOs only after reviewing each field. The mock contract is behavioral evidence, not automatically the production wire format.

### 5.1 Universal request rules

- `X-Request-Id` or generated correlation ID on every request.
- `Idempotency-Key` required for every externally retryable command.
- `If-Match` or an explicit `expectedRevision` required for state-dependent mutation.
- Cursor pagination bound to actor visibility, filters, sort, and resource scope.
- UTC ISO timestamps at boundaries; timezone names retained separately for schedules.
- Exact money and decimal quantities encoded as normalized strings.
- `202 Accepted` plus an operation receipt for asynchronous work.
- `201 Created` only when the resource is committed synchronously.
- `404` for inaccessible foreign resources where existence is sensitive; `403` for a known in-scope prohibited action.
- Stable structured errors: `unauthenticated`, `forbidden`, `not_found`, `conflict`, `validation`, `capability`, `quota`, `rate_limited`, `unavailable`, and `internal`.

### 5.2 Operation contract

An operation includes stable ID, kind, actor snapshot, resource scope, state, revision, idempotency digest, steps, progress, cancellation state, error category, created/started/completed timestamps, result references, and safe audit metadata.

States are `queued`, `running`, `cancel_requested`, `succeeded`, `failed`, `cancelled`, and `partially_succeeded`. Terminal states never move. Retry creates an attempt while retaining the original operation identity when the contract says resume; otherwise it creates a linked operation.

### 5.3 Event and subscription contract

- Use SSE for dashboard operation/log/event feeds unless bidirectional messaging is actually required.
- Use WebSocket for app realtime subscriptions.
- Every stream has an authorization-bound cursor, ordered sequence, heartbeat, reconnect window, and terminal authorization-revoked message.
- Events are persisted before publication through an outbox. Consumers deduplicate by event ID.
- Membership, session, credential, or realm revocation closes affected streams and invalidates replay cursors.

## 6. Carbon Cloud data model and migrations

Add additive, versioned migrations. Do not rewrite migrations `0001`–`0004`.

### 6.1 Identity and organization tables

- `accounts`: verified identity, primary email, state, terms version, security revision.
- `account_identities`: email/OIDC provider subject, verified timestamps, uniqueness.
- `account_sessions`: opaque token hash, device metadata, expiry, MFA state, revoked timestamp.
- `mfa_factors` and `recovery_codes`: encrypted metadata and one-way code hashes.
- `organizations`: extend with slug, state, owner policy, deletion schedule, revision.
- `memberships`: account/org role, status, revision; enforce at least one active owner.
- `project_assignments` and `membership_grants`: explicit project/environment permission grants.
- `invitations`: email, role, assignments, token hash, expiry, supersession, acceptance.
- `notifications`: account-visible delivery-safe records.
- `service_accounts`, `personal_tokens`, `service_credentials`, `device_codes`.

Backfill every existing organization with a migration-owner account only through an explicit administrative claim flow. Do not fabricate an email or silently grant ownership. Existing `cc_` organization tokens become legacy automation credentials with a published expiry/deprecation path.

### 6.2 Catalog and configuration tables

- `projects`: canonical ID, org ID, name, slug, state, revision.
- `environments`: project ID, name/kind, state, production policy, revision.
- `service_bindings`: owner, remote resource ID, provisioning state, operation ID, revision.
- `repository_installations`, `repositories`, `project_repository_configs`.
- `configuration_revisions`: immutable normalized snapshots and source/proposal origin.
- `secrets`: name and metadata only; `secret_versions` stores encrypted envelope references.
- `environment_credentials`: prefix/hash/scopes/expiry/status, never plaintext.
- `operations`, `operation_steps`, `operation_attempts`, `outbox_events`.
- `audit_events`, `activity_events`, `capability_snapshots`.

### 6.3 Delivery tables

- Extend `builds` with project/environment/configuration/source/plugin snapshot IDs, request actor, cancellation, timeout, quota reservation, and revision.
- `build_attempts`, `build_stages`, `build_log_segments`, `build_artifacts`, `worker_leases`.
- `workers`, `worker_enrollments`, `worker_heartbeats`, `worker_capabilities`.
- `signing_profiles` and encrypted signer references.
- `releases`, `release_artifacts`, `release_manifests`, `channels`, `channel_revisions`, `rollout_changes`, `withdrawals`.

Migrate legacy builds by retaining their organization ownership and marking missing project/environment/configuration references as `legacy`. They remain readable but cannot be published until explicitly adopted into a project.

### 6.4 Billing/operator/recovery tables

- Generalize `usage_records` with kind, quantity string, unit, resource scope, event key, period, and source operation.
- `subscriptions`, `provider_events`, `invoices`, `budgets`, `quota_reservations`, `billing_adjustments`.
- `operator_accounts`, `operator_roles`, `operator_actions`, `suspensions`.
- `deletion_requests`, `retention_holds`, and retained-resource manifests.

Provider event IDs and metering event keys are unique. Reconciliation is repeatable and never double-charges.

## 7. BE-01: human identity, sessions, MFA, and membership

Place reusable business rules under `solutions/capabilities/cloud/identity` and app-user rules under the existing `solutions/capabilities/cloud/auth`. Product HTTP/cookie adapters remain in Carbon Cloud.

Implement:

- Generic registration/recovery responses to prevent account enumeration.
- Email challenge delivery through a new notification port and a configured provider adapter; development uses an explicitly named inbox adapter.
- Atomic single-use challenge consumption.
- OIDC authorization-code + PKCE for configured GitHub identity, with exact redirect allowlists and verified linking policy.
- Session issue/rotate/revoke, secure cookies, CSRF, fresh-auth challenges, device/session listing.
- MFA enrollment/verification/disable and one-time recovery-code replacement.
- Invitation create/resend/cancel/accept, membership/role/grant changes, ownership transfer, leave, and last-owner protection.
- Immediate authorization revision increment and revocation event emission.
- Separate account, app-user, worker, service-account, and operator audiences.

Acceptance: complete the Slice 2 walkthrough against Postgres and a captured email provider in development; revoke membership in one tab and observe access and streams disappear in another.

## 8. BE-02: canonical catalog and provisioning

Cloud becomes the only creator of project/environment identity. Database must remove public independent project creation once compatibility consumers migrate.

Implement a saga-style provisioning operation:

1. Commit Cloud project/environment and required binding intents.
2. Call each owning service with idempotency key and canonical IDs.
3. Persist independently completed steps.
4. Expose degraded/partial state without deleting successful work.
5. Retry only incomplete steps after checking the current actor and revision.

Every service provides idempotent internal `ensure`, `pause`, `resume`, and lifecycle-status endpoints. A service stores Cloud canonical IDs as foreign references and rejects attempts to rebind an existing remote resource to another scope.

Project archive stops new work but preserves recovery. Environment pause blocks mutations and scheduled execution while retaining reads allowed by policy. Production creation and destructive changes require explicit grants and project policy confirmation.

## 9. BE-03: authorization and tenant isolation

This is a release blocker for every other production adapter.

Implement one permission vocabulary matching the frontend contract. Cloud resolves membership, project assignment, role preset, explicit grants, environment policy, suspension, and capability state into an effective decision. Downstream services also verify resource ownership locally.

Database isolation requirements:

- Use a distinct restricted database role per environment or a transaction-local authorization mechanism backed by native Postgres privileges/RLS.
- Revoke cross-schema access. Dynamic SQL runs only through a restricted role with explicit statement/timeout limits.
- Validate all identifiers and prevent search-path escape, extension administration, role changes, filesystem access, network-capable functions, and cross-tenant catalog reads.
- RLS policies fail closed. Unsupported syntax is rejected at creation, never treated as true.
- SELECT/DELETE evaluate existing rows; INSERT evaluates proposed rows; UPDATE evaluates both existing and proposed rows.
- Administrative customer-data access is a separate permission and always audited.

Blob, vector, graph, realtime, export, function, and backup endpoints apply the same canonical binding and permission checks. No route may merely authenticate and then trust `projectId` from the path.

Run a two-organization adversarial matrix against every query, mutation, download, stream, cursor, operation, and error path before enabling production traffic.

## 10. BE-04: application authentication

Extend the existing Cloud auth authority from organization scope to one realm per project/environment.

Implement:

- `realms`, `app_users`, `app_identities`, `app_challenges`, `app_sessions`, `app_auth_events`, and provider configuration references.
- Signup enablement, verified email magic links, OIDC providers, exact redirect allowlists, session TTL, logout, rotation, revocation, suspension, soft deletion, and export.
- Realm-bound tokens with `aud=app`, user ID, realm/project/environment, claims revision, issued/expiry times, and unique session ID.
- Public realm configuration that exposes no provider secret.
- Auth-event rate limiting, abuse controls, and generic public responses.
- Database policy context derived only from a verified app assertion.

Stored provider secrets use the secret system. Changing critical realm configuration can invalidate sessions through an explicit operation.

## 11. BE-05: repository, credentials, and secrets

### 11.1 Repository integration

- Add a vendor-neutral repository installation port and an initial GitHub App adapter.
- Store installation/repository identifiers, not reusable personal access tokens.
- Validate org/repository installation access on every refresh and webhook.
- Verify webhook signature and delivery ID; deduplicate delivery IDs.
- Resolve branch/ref to an immutable commit before queueing a build.
- Dashboard edits create a proposal/patch or pull request. They never silently overwrite the source repository.

### 11.2 Secrets and credentials

- Use envelope encryption: per-secret data key, KMS/HSM-backed wrapping key, encrypted bytes, version, scope, and audit metadata.
- Return a newly issued token exactly once; store only its hash/prefix/metadata.
- Rotation can overlap only for the configured bounded period.
- Never expose an existing secret value. Build/function workers receive short-lived materialized bindings for one lease.
- Personal, service-account, environment, worker, device, internal-service, and app-session credentials have different prefixes, audiences, and verifiers.

## 12. BE-06: Windows build execution

Refactor Cloud orchestration around immutable inputs and attempts while retaining the existing worker capability.

Build creation:

1. Check live permission, environment state, repository readiness, plugin lock/trust, signing capability, and quota.
2. Resolve the source ref and snapshot configuration, toolchain, environment, dependency lock, secret references, target formats, and actor.
3. Reserve quota idempotently.
4. Commit the queued build and outbox event.

Worker protocol:

- Enroll a worker with a one-time credential and store platform/toolchain capabilities.
- Claim via lease with attempt ID, lease token, expiry, heartbeat interval, and immutable build input URL.
- Heartbeat renews only the matching active lease.
- Log upload is ordered, bounded, append-only, redacted, and persisted outside process memory.
- Artifact completion includes object reference, size, SHA-256, target, signature state, and provenance attestation.
- Server verifies declared objects/digests before accepting success.
- Cancellation is cooperative, expires the lease, and cannot later transition to success.
- Lease expiry creates a recoverable attempt and retries only within policy.

Execution:

- Use disposable Windows worker isolation with no shared customer workspace.
- Fetch exact commit, lock dependencies, verify plugin digests/signatures, apply declared grants, compile, package NSIS/WiX, sign where configured, upload, then erase workspace/secrets.
- Enforce CPU, memory, disk, wall-time, network, log, artifact, and concurrency limits.
- Default build network is denied except declared repository/dependency endpoints.

Proof gate: perform a real Windows-host build of a fixture app, validate Authenticode, install into a clean Windows VM, launch it, update it, uninstall it, and match every artifact digest/provenance record.

## 13. BE-07: releases, channels, signing, and updater compatibility

Cloud adds explicit release management routes and composes the existing distribution capabilities.

- A release references only accepted immutable build artifacts.
- Publication creates immutable release metadata, manifest bytes, signatures, compatibility bounds, data environment, migration warnings, and artifact digests.
- A channel is a mutable pointer with immutable channel revisions and deterministic rollout configuration.
- Promotion creates a new audited channel revision; it does not mutate a release.
- Withdrawal blocks new offers. Forced recall/restart is never claimed unless the installed runtime contract implements it.
- Signing profiles reference protected keys/certificates; private keys never enter Cloud tables or logs.
- Public manifest and artifact URLs use project-scoped collision-resistant keys and correct cache rules.

Create conformance fixtures shared by publisher, TypeScript updater, standalone updater, and Rust updater. Prove signature bytes, version ordering, rollout bucket, stop-list, failure rollback, compatibility rejection, and channel movement across every active consumer. Select one canonical production updater path per packaged application and deprecate ambiguous duplicates.

## 14. BE-08: relational data and policy lifecycle

Database implements the production `DataService` contract:

- Paginated table catalog with stable table IDs and schema revisions.
- Supported typed columns, defaults, primary keys, constraints, dependency impact, migrations, and optimistic revisions.
- Structured row filters, sort, projection, selected IDs, JSON paths, imports, exports, generated types, and bounded result sizes.
- Exact decimal-string behavior at the boundary.
- Atomic schema and row commands with old/new policy checks.
- Saved queries and asynchronous SQL jobs with cancellation, statement timeout, result expiry, and redacted history.

Raw SQL is an administrative feature, not the application data API. Publish an explicit allow/deny matrix and execute with restricted roles. Exports live in private object storage and are downloaded using short-lived, single-purpose URLs after authorization recheck.

Remove the Database UI's independent signup/project creation path after the unified frontend reaches parity. Keep a temporary compatibility redirect or clearly deprecated API only for a defined migration window.

## 15. BE-09: blobs, vectors, graph, and realtime

### 15.1 Blobs

- Bucket lifecycle includes visibility, MIME/size policy, versioning, retention, quota, and revision.
- Store exact binary bytes; remove base64 JSON as the production transfer path.
- Use presigned single-purpose upload/download URLs with short TTL, exact object key/content constraints, and completion verification.
- Public download checks current bucket/object policy before redirecting or serving.
- Private listing, metadata, byte access, version restore, and deletion all require binding/permission checks.
- Meter stored bytes and egress idempotently.

### 15.2 Vector and graph

- Enforce collection dimensions, bounded batch sizes, deterministic scoring contract, metadata filters, indexes, quotas, and lifecycle revisions.
- Enforce node/edge referential rules, bounded traversals, maximum depth/result size, and indexed project scoping.
- Large vector/graph jobs become cancellable operations.

### 15.3 Realtime

- Persist mutations and an outbox event in one transaction.
- Publish through a durable broker or Postgres logical/outbox consumer, not process-local maps.
- Authenticate app/dashboard subscriptions, authorize topic/table/filter, apply row policy per event, and bind cursors to the principal visibility revision.
- Provide heartbeat, ordered cursor, bounded replay, reconnect, deduplication, and revocation closure.
- Never imply coverage for mutations that bypass the supported capture path.

## 16. BE-10: functions and schedules

Move execution out of the Database service process into isolated workers while Database remains the resource owner.

- Store mutable drafts separately from immutable source revisions, packages, deployments, and environment activations.
- Packaging validates source and declared imports without executing the draft.
- A deployment snapshots code digest, runtime, limits, secret version references, service credential, and configuration.
- Invocation accepts dashboard, app, or service principals only through explicit grants.
- Worker isolation enforces CPU, memory, wall time, response size, concurrency, filesystem, and egress policy.
- Logs and results are redacted, bounded, durable, and retention-controlled.
- Retry records the original deployment/configuration snapshot.
- Schedules store IANA timezone, DST behavior, overlap policy, missed-run policy, next occurrence, and dedicated credential.
- Promotion/rollback preserves source digest while reviewing target bindings and permissions.
- Disable blocks new invocations, disables schedules, and cooperatively cancels pending/running work according to the contract.

Do not use `AsyncFunction`, `eval`, or equivalent in the HTTP process in production composition.

## 17. BE-11: Registry publishing and trust

Registry adds:

- Organization-owned publisher namespaces with an explicit mapping to loader-compatible local slugs.
- Publisher membership/grants separate from public package visibility.
- Package draft, version submission, validation, review, approval, publication, deprecation, and security revocation states.
- Immutable version bytes and metadata after publication.
- Validation of archive format, manifest, ABI, target triple, permissions, forbidden paths/symlinks, expansion ratio, executable contents, signatures, and reproducible digest.
- Quarantine storage for pending uploads and promoted immutable storage for approved versions.
- Real versioned Windows fixtures for standard packages, or an unmistakable `fixture` label that cannot resolve into production builds.
- Persistent signing keys in KMS/HSM or protected key storage; startup fails in production if stable trust is unavailable.
- Independently distributed signed trust bundle with active/retiring/revoked keys, rotation overlap, and offline-pinnable root.
- Security revocation blocks future resolution but preserves historical release provenance.

Operator review records immutable evidence and reason. Operators cannot publish as a customer.

## 18. BE-12: plugin consumption and CLI changes

Cloud project plugin commands manage desired state and source synchronization; Registry remains the version authority.

Resolution flow:

1. Read desired dependency declaration from an immutable commit.
2. Resolve exact compatible version/target/digest and trust state.
3. Present newly requested capabilities for approval.
4. Write a source proposal and exact lock through repository integration.
5. Build only from the committed declaration and lock.
6. Download, verify against pinned trust, safely extract, stage DLL/signatures, and record provenance.

Change Carbon CLI to use account/device authorization and narrow tokens. Add commands for login/logout, organizations/projects/environments, builds/logs/artifacts, releases/channels, and exact plugin synchronization. Preserve offline local plugin development.

CLI must never trust a key merely because the archive endpoint returned it. It pins the configured Registry root/trust bundle, rejects path traversal and archive bombs, verifies digest/signature/target/ABI, and writes the lock atomically.

## 19. BE-13: billing, quotas, operators, and recovery

### 19.1 Billing and quota

- Consume signed provider webhooks into an idempotent event inbox, then update a local subscription projection.
- Model free, checkout-pending, active, past-due, cancel-scheduled, and ended states.
- Persist invoice metadata and use provider-hosted invoice downloads unless a compliant local copy is deliberately stored.
- Meter builds, storage, function invocation, and egress using unique source event keys.
- Reserve quota before charged work; settle or release it on terminal outcome.
- Budgets emit warnings or hard-cap new charged work without deleting existing resources.
- Billing-only members see financial/aggregate usage but not customer project data.

### 19.2 Operator boundary

- Operator accounts and roles are independent of customer memberships.
- No default impersonation. Any future support access requires customer authorization, time limit, reason, and immutable audit.
- Operator actions require reason, expected revision, scoped role, and often two-person approval for trust rotation or destructive recovery.
- Suspension blocks new charged/customer mutations while preserving authorized recovery metadata.

### 19.3 Recovery and deletion

- Migrations are immutable, checksummed, ordered, drift-detected, and promoted between environments through reviewed operations.
- Backups record schema/data/blob/vector/graph/function coverage plus explicit exclusions for plaintext secrets and live sessions.
- Restore targets a new or explicitly replaceable environment, locks conflicting writes, records each category, and preserves partial successes.
- Recovery points and exports have enforced retention/expiry.
- Organization/project deletion is scheduled and reversible during a recovery window, previews blockers/retained records, respects legal holds, and executes per owner with reconciliation.

## 20. Production browser adapters

Add:

```text
products/carbon-cloud/
  composition/
    browser.production.tsx
    create-production-browser-services.ts
    vite.production.config.ts
  infrastructure/browser/http/
    HttpClient.ts
    IdentityHttpService.ts
    PlatformHttpService.ts
    ConfigurationHttpService.ts
    DeliveryHttpService.ts
    DataHttpService.ts
    AppAuthHttpService.ts
    ExtensionHttpService.ts
    FunctionHttpService.ts
    RegistryHttpService.ts
    BillingHttpService.ts
    OperatorHttpService.ts
```

Rules:

- Keep `create-mock-services.ts` and production creation entirely separate.
- Production bundles must not import `infrastructure/browser/mock`, mock tools, fixture state, fake inbox links, or scenario controls.
- `HttpClient` implements cookies, CSRF, request IDs, structured errors, cancellation, idempotency, revision headers, and safe retry policy.
- Retry GET/HEAD and explicitly idempotent commands only. Never blindly retry a non-idempotent mutation.
- Service adapters translate wire DTOs into browser contracts; React feature pages do not call `fetch` directly.
- Capability responses drive unavailable UI. Network failure never activates mock behavior.
- Production CSP and asset checks run against the built production entry.

Add an automated forbidden-import check and bundle inspection proving mock modules are absent.

## 21. External API families

Exact OpenAPI documents are authored during contract foundation, but the route ownership is fixed:

| Owner | Route families |
|---|---|
| Cloud public/account | `/platform/v1/auth/*`, `/platform/v1/account/*`, `/platform/v1/invitations/*` |
| Cloud organizations | `/platform/v1/orgs/:orgId/{members,invitations,projects,settings,activity,billing,workers}` |
| Cloud project/environment | `/platform/v1/orgs/:orgId/projects/:projectId/*`, nested `/environments/:environmentId/*` |
| Cloud delivery | nested `builds`, `artifacts`, `releases`, `channels`, `signing`, and log/event streams |
| Cloud operations | scoped `/operations`, `/audit`, `/events`; `/platform/v1/operator/*` with operator audience |
| Cloud public update | `/updates/v1/projects/:projectId/channels/:channel/manifest`, sibling stop-list/artifacts |
| Cloud app auth | `/app-auth/v1/realms/:realmId/*` public/session endpoints and internal admin routes |
| Database internal/admin | `/internal/platform/v1/environments/:environmentId/*` for catalog and dashboard commands |
| Database application | `/data/v1/realms/:realmId/*`, `/storage/v1/*`, `/realtime/v1/*`, `/functions/v1/*` |
| Registry public | `/registry/v1/packages/*`, `/registry/v1/trust/*` |
| Registry publisher/internal | `/internal/platform/v1/publishers/*`, packages/versions/reviews/trust lifecycle |
| Worker | `/worker/v1/claims`, leases, logs, artifacts, completion, heartbeat |

Existing `/v1`, `/api`, `/api/v1`, and `/rest/v1` routes receive a documented compatibility classification: retained public contract, adapted legacy contract, deprecated with sunset date, or internal-only. Do not leave two writable authorities indefinitely.

## 22. Changes required by product

### 22.1 `products/carbon-cloud`

- Add production browser composition and HTTP adapters.
- Expand Postgres migrations for identity, catalog, operations, delivery, billing, and operator state.
- Replace monolithic route growth with route modules by subject while keeping product-owned HTTP presentation.
- Add cookie/CSRF middleware, authorization resolver, internal assertion issuer, outbox publisher, job runners, repository/email/payment adapters, object-store query model, and SSE feeds.
- Compose existing solution capabilities instead of duplicating business rules in routes.
- Serve production frontend separately from mock frontend.

### 22.2 `products/carbon-database`

- Accept canonical Cloud project/environment binding and internal assertions.
- Add strict resource-ownership checks to every route.
- Replace unsafe tenancy assumptions with restricted DB roles/native controls.
- Implement production data/storage/vector/graph/realtime/migration/backup/function contracts.
- Move function execution and asynchronous jobs to workers.
- Remove independent account/project ownership and retire its separate studio after unified parity.

### 22.3 `products/carbon-registry`

- Add publisher namespace, grants, workflow, review, trust rotation/revocation, quarantine, and immutable version migrations.
- Validate real Windows archives and persist review evidence.
- Require stable protected signing configuration in production.
- Accept internal assertions for private/publisher/operator routes while public catalog/download remains anonymous where visibility permits.
- Retire the separate marketplace UI after unified public catalog parity, or keep it as a read-only consumer of the same public API.

### 22.4 `products/carbon-cli`

- Replace organization-token login with device authorization and narrow credentials.
- Add unified scope selection and production Cloud commands.
- Update Database and Registry calls to canonical project/environment IDs.
- Implement safe plugin resolution/extraction/lock/source-sync behavior.
- Preserve explicit base URL configuration for self-hosting.

### 22.5 `products/carbon-updater` and runtime consumer

- Select and document the canonical updater integration per desktop package.
- Consume the versioned shared update contract and pinned keyring.
- Align rollout, stop-list, compatibility, crash reporting, and rollback behavior.
- Add end-to-end fixtures generated by the actual publisher.
- Never report device health unless the app explicitly enables the documented telemetry contract.

### 22.6 `solutions/`

- Extend Cloud identity, auth, orchestration, billing, distribution publishing/signing/updating, and plugin lifecycle capabilities.
- Add domain/use-case/port code here when it represents business rules reusable across driving adapters.
- Add vendor adapters under `solutions/integrations/<role>/<vendor>` where appropriate.
- Create shared platform contracts only for formats with multiple real consumers.
- Keep product HTTP routes, browser pages, CLI commands, and composition in products.

## 23. Migration and compatibility strategy

### 23.1 Database migration rules

- Migrations are forward-only, checksummed, transactional where the database permits, and exercised against a copy of real baseline schemas.
- Expand first: nullable/additive columns, new tables, dual-read or dual-write adapters where necessary.
- Backfill in resumable bounded jobs with progress and verification queries.
- Enforce constraints only after backfill proves them.
- Contract old fields/routes only after usage telemetry shows no supported consumer.
- Every migration has rollback/recovery instructions even when schema rollback is not automatic.

### 23.2 Legacy identity

- Existing `cc_` org tokens are classified as legacy automation tokens.
- Provide an owner-claim process to attach old organizations to verified accounts.
- Show legacy token usage and allow rotation into service accounts.
- Disable issuance first, then warn, then expire after a published window.

### 23.3 Legacy projects

- Import Database projects into Cloud catalog through a reconciler that preserves IDs where valid.
- Detect collisions and require explicit mapping; never merge by name.
- Create environment bindings and mark incomplete ownership as requiring operator resolution.
- Legacy builds remain historical and can be adopted only after repository/environment confirmation.

### 23.4 API versioning

- Publish OpenAPI for external HTTP APIs and JSON Schema for events/manifests.
- Breaking changes require a new major media/route version and a dual-support window.
- Internal assertions and service endpoints are also versioned; independent deployment requires N/N-1 compatibility.
- Contract conformance runs before product integration tests.

## 24. Implementation sequence and gates

| Phase | Scope | Depends on | Exit gate | Recommended coding model |
|---|---|---|---|---|
| 0 | Baseline, decision records, shared contract schemas, CI conformance | None | Contract fixtures compile in all consumers | GPT-6 Astra, high |
| 1 | Human identity, sessions, membership, internal assertions | 0 | Revocation and cross-audience tests pass | GPT-6 Astra, high |
| 2 | Canonical catalog, bindings, operations/outbox/audit | 1 | Partial provisioning survives restart/retry | GPT-5.6 Sol, high |
| 3 | Tenant authorization and Database isolation | 1–2 | Two-tenant adversarial suite passes | GPT-6 Astra, max |
| 4 | Production browser core adapters, repository, credentials, secrets | 1–3 | Slices 1–3 work without mocks | GPT-5.6 Sol, high |
| 5 | Windows builds, workers, durable logs/artifacts, quota reservations | 2–4 | Real Windows VM installer proof passes | GPT-5.6 Sol, high |
| 6 | Releases, signing, channels, updater conformance | 5 | Publisher-to-installed-update E2E passes | GPT-6 Astra, high |
| 7 | Relational data and realm app auth | 3–4 | Policy and app-session suite passes | GPT-6 Astra, high |
| 8 | Blobs, vectors, graph, realtime, migrations, backups | 7 | Isolation/replay/restore suites pass | GPT-5.6 Sol, high |
| 9 | Isolated functions and schedules | 7–8 | Escape/resource/retry/schedule suite passes | GPT-6 Astra, high |
| 10 | Registry trust/review and plugin consumption/CLI | 3,5 | Real signed Windows plugin build passes | GPT-6 Astra, high |
| 11 | Billing, budgets, operators, deletion/recovery | 2,5,7–9 | Idempotent billing and restore drills pass | GPT-6 Astra, high |
| 12 | Full production adapter parity and mock exclusion | 4–11 | Every frontend walkthrough passes on real services | GPT-6 Astra, xhigh |
| 13 | Canary, observability, security review, disaster-recovery exercise | 12 | Production readiness approval | GPT-6 Astra, max |

Phases may parallelize only after their dependency gate. Shared contract edits require one compatibility owner. Do not let feature branches copy DTOs to avoid coordination.

## 25. Verification strategy

### 25.1 Required test layers

- Domain tests for permission, state-machine, lifecycle, quota, rollout, and retention rules.
- Use-case tests with deterministic fakes for failure, retry, idempotency, concurrency, and cancellation.
- Contract conformance tests shared across browser/Cloud/Database/Registry/CLI/workers/updater.
- Repository integration tests against real Postgres/object storage/broker.
- Product API tests for cookies, CSRF, headers, status codes, redaction, and route ownership.
- Cross-product tests using real independently started services.
- Playwright or equivalent browser E2E against the production bundle, never the mock composition.
- Windows worker/installer/updater tests on a real Windows runner and clean VM images.
- Security tests for tenant escape, SQL escape, archive traversal/bombs, SSRF, webhook forgery/replay, token confusion, cursor leakage, stale authorization, and secret leakage.
- Load/soak tests for build claims, logs, realtime fanout, function concurrency, uploads, and usage aggregation.
- Backup restoration and service-loss drills.

### 25.2 Non-negotiable walkthroughs

Repeat every functional walkthrough from section 22.3 of the frontend plan against production adapters. Additionally:

- Restart each service during active work and prove durable recovery.
- Deploy Cloud, Database, and Registry one version apart in both directions.
- Rotate Cloud assertion keys, Registry trust keys, signing certificates, provider secrets, and environment credentials.
- Revoke a human/app/service/worker credential during an active request and stream.
- Attempt every resource ID from another organization.
- Restore a backup into a new environment and compare the declared manifest to actual recovered categories.
- Reconcile duplicated/out-of-order payment, repository, worker, and scheduler events.
- Prove that the production bundle contains no mock code or fixture credentials.

## 26. Deployment, observability, and operations

- Separate development, staging, and production infrastructure and credentials.
- Terminate TLS at a controlled ingress; encrypt service and datastore traffic.
- Run database migrations as an explicit release step with advisory locking.
- Add readiness checks that validate required dependencies without mutating them.
- Emit structured logs with correlation/resource IDs but no token, secret, raw customer row, function payload, or payment data.
- Metrics: request/error/latency, auth denial, operation queue/age, worker lease/heartbeat, build duration/failure, storage/egress, realtime connections/lag, function saturation, provider webhook lag, outbox lag, backup age/restore result.
- Traces propagate across Cloud, Database, Registry, workers, provider adapters, and asynchronous operations.
- Alerts cover authorization anomalies, stuck operations, lease storms, outbox backlog, signing/trust failures, quota reconciliation, failed backups, and expiring keys/certificates.
- Define SLOs only after measurement. Fixture values are not production promises.
- Runbooks cover provider outage, object-store outage, database failover, stuck build/function, key compromise, Registry revocation, billing replay, and partial restore.

## 27. Security and privacy release checklist

- Threat model reviewed for every principal and trust boundary.
- Secure cookie, CSRF, CORS, CSP, redirect, and session-fixation protections verified.
- Passwords are not introduced unless a complete password security program is deliberately selected.
- Token/secret values are one-time, hashed or envelope-encrypted, redacted, and rotation-tested.
- Service assertions are audience-bound, short-lived, replay-aware, and key-rotation compatible.
- Tenant isolation is enforced in application and datastore layers.
- SQL and function execution are sandboxed and resource-bounded.
- Upload/archive handling prevents traversal, symlink escape, decompression bombs, and untrusted execution during validation.
- Public blobs/packages/manifests have explicit visibility; private objects cannot be reached through guessed keys.
- Payment data stays with the provider; webhook signatures and replay windows are enforced.
- Data export, deletion, audit retention, backup retention, and operator access have deliberate policies.
- Dependency and container scanning, SBOM/provenance, signed releases, and patch procedure are active.
- Independent security review signs off before production customer data is admitted.

## 28. Cutover

1. Ship real services and production adapter bundle behind an environment-level feature flag.
2. Run production adapters in staging with seeded non-sensitive accounts and all walkthroughs.
3. Import legacy organizations/projects and verify reconciliation reports.
4. Enable internal users, then a small opt-in canary organization set.
5. Compare operations, errors, billing, resource counts, and audit coverage; do not compare by dual-writing customer mutations unless the owning transaction supports it.
6. Expand cohorts only when phase gates and error budgets hold.
7. Make production composition the default; retain an explicit link/command for mock mode only in development.
8. Stop legacy writes, keep documented reads during the compatibility window, then remove deprecated routes.

Rollback means route traffic back to the previous production version while preserving already committed operations and reconciling them. It never means switching production users to the mock adapter or discarding newer database state.

## 29. Definition of done

The platform backend program is done when:

- All frontend service methods have a versioned real contract and production implementation, or a deliberate visible capability limit.
- Production browser code contains no mock imports, state, fixtures, fake provider results, or fallback.
- Cloud is the sole account/org/project/environment authority.
- Database and Registry independently enforce canonical resource ownership and assertion audience.
- Every material mutation is idempotent where retryable, revision-aware, audited, and represented by durable state.
- Secrets are never returned after creation and never appear in logs/audit/events.
- Windows build, signing, installer, release, channel, and updater flow passes on real Windows infrastructure.
- App-user policy, private blob, realtime, function, Registry trust, plugin grant, billing, and recovery adversarial tests pass.
- Cross-product N/N-1 deployment and provider-event reconciliation pass.
- Backup restoration and key-rotation drills have recorded evidence.
- Every frontend-plan production walkthrough passes after process restarts.
- Mock mode still passes its existing deterministic suite as a contract/demo environment.

## 30. Decisions required before affected phase starts

| Decision | Deadline | Safe planning default |
|---|---|---|
| Human identity provider/email vendor | Phase 1 | Email magic link plus GitHub OIDC; provider ports |
| Session/MFA/fresh-auth policy | Phase 1 | Short browser session, rotating opaque cookie, owner MFA capability |
| Internal assertion signing/KMS | Phase 1 | Asymmetric keys with pinned issuer and overlap rotation |
| Database tenant isolation mechanism | Phase 3 | Restricted per-environment role plus native privileges/RLS |
| Repository provider | Phase 4 | GitHub App first, vendor-neutral port |
| Secret/signing key custody | Phase 4/6 | Managed KMS/HSM in hosted production; explicit file adapter for self-hosting |
| Managed Windows execution environment | Phase 5 | Disposable Windows VM runner; no privileged shared workspace |
| Canonical updater path | Phase 6 | Rust runtime updater for packaged apps; other path retained only if proven consumer exists |
| Realtime transport/broker | Phase 8 | Transactional outbox plus durable broker; WebSocket edge |
| Function isolation runtime | Phase 9 | Disposable sandbox worker with deny-by-default egress |
| Registry root trust distribution | Phase 10 | Offline-pinnable signed root bundle with rotation metadata |
| Commercial prices/quotas/tax handling | Phase 11 | Existing free/pro names; no invented production price |
| Retention/deletion/legal-hold policy | Phase 11 | Configurable documented policy; deletion remains reversible until approved |
| Hosting regions and residency | Phase 13 | No region selector until placement is real and enforceable |

These decisions can change adapters and policy values. They do not change the ownership, isolation, idempotency, audit, or no-fallback architecture in this plan.

