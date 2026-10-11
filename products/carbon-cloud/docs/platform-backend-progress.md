# Platform backend implementation evidence

The completion boundary remains the entire `platform-backend-plan.md` and its
frontend walkthroughs, including real Windows installer/update evidence and
production service cutover. This file records evidence, not a substitute scope.

## 2026-09-12: contract and identity foundation

Implemented:

- Shared platform JSON Schema, generated TypeScript, strict runtime validation,
  conformance fixtures, compatibility/redaction rules and Bazel conformance test.
- The browser's reviewed permission/role vocabulary now comes from the shared
  contract. Existing mock behavior remains separately implemented.
- Pinned, short-lived service assertions with request/body/scope/audience/grant
  validation, live-authority port, rotation overlap and persistent replay adapter.
- Explicit account membership permission rules, including denial of operator
  substitution and Billing customer-data grants.
- Cloud migration ledger with checksums, advisory locking, history validation,
  transactional rollback and portable newline normalization. Original migrations
  0001–0004 remain unchanged.
- Additive 0005 schema for human accounts, identities, challenges, sessions, MFA,
  memberships, invitations, service credentials, security event outbox and replay
  protection. Existing organizations receive no fabricated owner.
- Explicit `bun run --cwd products/carbon-cloud migrate` command.

Verified against an isolated local PostgreSQL 16 container:

- Fresh migration and three concurrent deployers.
- Adoption of actual baseline schemas with preserved legacy token and org data.
- Checksum changes, missing history and backdated migrations rejected.
- Failed migration rolls back schema and ledger; corrected migration retries.
- 124 passing tests across 14 files, with 734 assertions, on the final dependency
  versions. These include shared contracts, identity, existing Cloud API,
  deterministic browser/mock suites and five real-Postgres integration tests.
- Persistent replay test includes 20 competing inserts with exactly one winner
  and safe expiry pruning.
- All 21 TypeScript projects pass the repository-wide Bazel TypeScript gate,
  including Cloud backend/browser, Database, Registry and CLI.

The three new Bazel contract/assertion/generated-type targets pass. A broader
workspace audit identified existing layout/cache violations: undeclared
`.claude`, `.history` and `.vscode` directories, and 242 boundary violations
covering `products/carbon/~/.cargo`, a local Zig toolchain executable and the
website design ZIP. The repository-wide gate is not green. These files have not
been deleted or hidden from the checks.

Dependencies are pinned to Ajv 8.20.0, ajv-formats 3.0.1 and jose 6.2.12. The Ajv
override keeps the formatter's transitive validator on the same patched version.
Bun's existing isolated install retained a stale nested symlink after updating
the lockfile; `bun install --cwd .config --force --frozen-lockfile` rebuilt it.

## 2026-09-12: durable email accounts and browser sessions

The previous goal turn made verified implementation progress. This continuation
revalidated that state and implemented the next account-facing workflow:

- A real account authentication use case and Postgres repository, separate from
  legacy app-user magic links and organization bearer tokens.
- Generic challenge receipts, exact terms-version consent, same-browser proof,
  persistent command deduplication and HMAC-protected email/peer rate limits.
- Additive 0006 migration for encrypted notification outbox state and rate limits.
- Envelope-encrypted email jobs, real Resend adapter, explicitly selected
  development inbox, and a separately runnable leased mail worker. Provider
  retries preserve the original payload/idempotency key; delivery/expiry clears
  the protected payload. Key rotation retains overlap for pending deliveries
  and, after the MFA continuation below, persistent enrolled factors.
- Atomic verification/account creation/session issuance. Recovery increments
  account security revision and revokes previous sessions in the same transaction.
- Product-owned HTTP presentation for bootstrap, challenge request/completion,
  current session and logout. HTTPS uses Secure/HttpOnly/host-only session cookies;
  mutations enforce Origin and session-bound CSRF where authenticated.
- Versioned account OpenAPI, setup/run documentation and environment example.
  The legacy Cloud server composes these real routes only with the explicit
  `CARBON_ACCOUNT_AUTH=enabled` flag. No HTTP-to-mock fallback was introduced.

Verification: 134 tests across 15 files, 849 assertions, all passed in one run
against the final worktree. This includes actual PostgreSQL and a captured Resend
transport, concurrent proof consumption, encrypted queue retry and lease recovery,
expiry, generic responses, CSRF, consent versions, redirects, payload bounds and
rate limits. Repository/worker reconstruction is tested; separate process-loss
drills and live Resend sends remain unproven. The Bazel TypeScript gate passes all
22 projects, including the new HTTP presentation config. The default Bazel
account target runs encryption/configuration tests and skips database scenarios
without their explicit test URL; the full 134-test run included those scenarios.

Run/setup details: [account-authentication.md](account-authentication.md).

## 2026-09-12: MFA and account session controls

Implemented:

- Shared account revision, security command/response, enrollment and bounded
  session-page contracts with generated types and runtime conformance fixtures.
- RFC 6238 TOTP with independent SHA-1 reference vectors. Pending enrollment
  expires, replacement erases the old protected secret, and confirmation is
  required before a factor becomes active. Factor secrets use envelope encryption.
- Durable counter replay protection and account-wide failed-attempt/lockout state.
  Failed proof attempts commit even when the HTTP response fails. Email login and
  recovery require active MFA; separate concurrent challenges cannot reuse a code.
- Ten one-time recovery codes, stored only as hashes. Replacement consumes its
  proof and invalidates all prior codes. An active organization's MFA requirement
  prevents disable without consuming the submitted proof.
- Revision/CSRF/freshness-checked security commands, atomic audit and safe durable
  idempotency receipts. MFA changes increment security revision, revoke all old
  sessions and rotate the actor's cookies without extending absolute expiry.
  Stored receipts never contain enrollment secrets, recovery codes or session tokens.
- Session rotation, scoped individual/other-session revocation and bounded active
  session listing. Cursors bind session/account revision/page size and expire;
  foreign, altered, expired and stale cursors are rejected. Logout advances account
  revision. Account-first locking serializes security mutations and page reads.
- Additive migration 0007 and updated OpenAPI, browser protocol and key-retention
  instructions. Email queue drainage alone does not permit retiring MFA keys.

Verification: 146 tests across 17 files, 1,019 assertions, all passed in the final
combined Cloud/identity/contracts run with real PostgreSQL. The suite includes the
existing legacy HTTP and browser mock regressions, MFA lifecycle/recovery/replay,
concurrent challenge consumption, persistent lockout, redaction, session expiry,
cross-account revocation and session-bound pagination. Provider delivery remains
a captured Resend transport; no real email was sent. OpenAPI JSON and its shared
schema references validate, and scoped `git diff --check` is clean.

All six selected Bazel targets pass: the complete workspace TypeScript gate,
generated contract drift, contract conformance, service assertions, TOTP and
account auth. The Bazel account target intentionally skips database scenarios
without the explicit test URL; the 146-test run above included those scenarios.
The previously recorded unrelated workspace layout/cache gate failures remain.

During verification, shrinking migration test pools exposed a Bun 1.3.10
`rejects.toThrow` matcher stall on repeated transaction rejection. Directly
awaiting/catching the migration failure resolved it with the same three-connection
pool; the migration runner remains unchanged. Cleanup hooks allow 30 seconds for
the expanded set of isolated databases. This is test evidence, not a production
load or process-loss drill.

## 2026-09-12: session-bound fresh authentication

Implemented the authenticated fresh-auth challenge request and completion API.
Requests accept no target email/account/session from the caller: the destination
comes from the live verified account, with session/CSRF authorization rechecked
under the account lock. The existing encrypted outbox, configured provider,
request deduplication and email/peer rate limits handle delivery.

Proofs bind the requesting browser, original session and account security revision.
Completion rejects public-login proof substitution, another session/account,
expired or revoked authority, and stale security context. Active MFA requires a
new accepted TOTP counter or unused recovery code. Failure counters commit and
concurrent completion has one winner. The transaction consumes the proof, rotates
only the actor's session/CSRF cookies, advances account revision and audits; it
restores freshness without extending original absolute expiry. Other sessions
remain valid. Account-before-challenge locking also covers deduplicated requests.

Migration 0008 adds the binding columns and constraint, consuming any legacy
unbound fresh-auth rows. Shared schema/generated types, OpenAPI and the browser
protocol document the new endpoints and one-time response behavior. The production
`/auth/fresh` page remains part of the pending real browser adapter.

Verification: the combined Cloud/identity/contracts run passed 150 tests across
17 files with 1,096 assertions, including four new real-PostgreSQL fresh-auth
scenarios. A subsequently added forward-upgrade regression also passed (one test,
four assertions), proving legacy proof invalidation and rejection of new unbound
proofs. The workspace TypeScript, generated-contract, contract-conformance and
account-auth Bazel targets all pass. OpenAPI JSON/shared references validate and
scoped diff checks are clean. The same captured Resend transport is used; live
email delivery and production cutover are not claimed.

## 2026-09-12: durable profiles and verified-email replacement

Implemented profile reads and revision/CSRF/idempotency-checked name and local
text-avatar updates. Ordinary display edits save without renewed authentication;
email-change request/cancellation require fresh authority. Names use the same
Unicode character limit as the shared wire schema and fresh-auth input.

Email changes queue an encrypted, distinct `ec_` proof to the proposed address
without replacing the verified identity. Proofs bind account, session, browser,
security revision and expiry. Only one change stays pending; supersession and
cancellation invalidate old proofs and erase pending delivery payloads. A safe
pending-change projection survives reload without exposing proof material.

Completion requires active MFA, rejects claimed identities without merging
accounts, and serializes with registration/login through email-identity locks.
It preserves the account ID, updates the email identity and verification stamp,
increments account/security revisions, revokes old sessions and outstanding
old/new-address sign-in proofs, and rotates the actor's cookies without extending
absolute expiry. An encrypted notice to the old address commits in the same
transaction and uses the real configured email worker/provider path.

Migration 0009 adds avatars, email-change records and typed queue ownership.
Existing encrypted jobs and the previous authentication writer's insert column
list remain supported through a generated challenge foreign key. The migration
test fixtures now support explicit historical version boundaries. Account test
databases are cleaned after each case to bound connection usage as coverage grows.

Verification: 156 tests across 17 files, 1,205 assertions passed in the combined
Cloud/identity/contracts run against real PostgreSQL. This includes four profile/
email lifecycle cases and forward migration compatibility with queued mail and
the previous writer. A final Unicode character-limit correction passed the six
affected profile/fresh-auth tests (100 assertions). Workspace TypeScript,
generated-contract, contract-conformance and account-auth Bazel targets passed;
OpenAPI JSON/shared references and scoped diff checks are clean. Provider retry
and notices were tested using captured Resend transport; no live email was sent.

## 2026-09-12: organization membership and ownership core

Implemented organization creation and discovery, member administration, leaving,
owner settings/MFA policy, and proposed/accepted ownership transfer against real
PostgreSQL. Routes follow `/platform/v1/orgs`, with membership commands under
`/{orgId}/members` and owner settings under `/{orgId}/settings`. Shared contracts,
generated types and [OpenAPI](organization-api.openapi.json) describe the API.

Migration 0010 distinguishes human-managed organizations from legacy unclaimed
ones, adds permission revisions, durable command receipts and security events,
and enforces an active owner with deferred database constraints. Legacy ownership
is never fabricated. Organization and ordered account locks serialize membership,
policy and ownership changes. Expired, cancelled and superseded proposals fail;
acceptance requires the named recipient's fresh session and required MFA.

Role delegation is limited to the actor's permissions. Revocation immediately
removes these organization endpoints while preserving other memberships and
sessions. Permission revisions invalidate scoped cursors. Atomic changes include
revision updates and durable audit/outbox records; downstream event publication
and stream closure remain pending. Member fixtures in tests are explicit SQL
setup and do not establish invitation acceptance evidence.

Verification: the combined Cloud/identity/contracts suite passed 161 tests in 17
files with 1,298 assertions against PostgreSQL. After correcting the route layout,
the six affected organization/ownership/MFA cases passed with 98 assertions.
Workspace TypeScript, generated-contract, contract-conformance and account-auth
Bazel targets passed; 318 OpenAPI/shared-schema references resolve.

## 2026-09-12: durable organization invitations

Implemented create/resend/cancel, bounded manager listings, verified-recipient
preview and atomic acceptance at the planned organization/account API routes.
The existing configured notification adapter and encrypted PostgreSQL queue
deliver seven-day invitation proofs with stable provider retry keys. Persistent
per-organization/actor/destination/peer delivery limits exclude exact retries.

Invitations bind the issuing membership and revision. Acceptance rechecks that
authority, current organization state/MFA policy, recipient verified email and
fresh session. Changing or revoking the issuer's membership invalidates its old
proofs even if its role is restored. Resend replaces the proof and authority
binding; cancellation and supersession erase pending delivery. New proofs never
authenticate an account or implicitly upgrade an active membership.

Acceptance creates or reactivates one membership, increments permission/profile
and organization revisions, and commits a safe receipt and invitation-referenced
audit/outbox event together. Same-key concurrent acceptance returns one durable
result. Cancellation racing acceptance commits one outcome. Receipt access is
denied after membership revocation.

Migration 0011 adds authority/acceptor references and typed invitation queue
ownership while preserving older mail writers. Historical unbound pending proofs
are superseded without inventing authority. Scoped assignments/grants remain
dependent on the canonical catalog: unsupported fields and persisted nonempty
assignments fail closed instead of granting a broader organization role.

Verification: 167 tests across 17 files and 1,430 assertions passed in the combined
Cloud/identity/contracts suite. Final audit-reference and test-response validation
changes passed seven affected invitation/migration cases with 130 assertions.
All four workspace TypeScript/generated-contract/conformance/account-auth Bazel
targets pass. All 402 OpenAPI/shared-schema references resolve; scoped diff checks
are clean. Email tests use real PostgreSQL and captured Resend transport, without
live recipients. See [organization-invitations.md](organization-invitations.md)
and [invitation-api.openapi.json](invitation-api.openapi.json).

## 2026-09-12: GitHub identity provider transport

Added the external-account provider port and named GitHub integration adapter.
It follows GitHub's documented OAuth authorization-code flow with S256 PKCE,
explicit email scope and exact callback URI. It verifies the authenticated user's
immutable numeric ID and verified email addresses through GitHub's APIs; it does
not fabricate an OIDC ID token or trust public profile email/MFA flags.

The adapter pins hosts and API version, rejects redirects, bounds response bodies
and email pagination, applies a shared timeout, sanitizes provider failures and
does not return or persist provider tokens. Six captured-transport tests pass
with 58 assertions, including the independent RFC PKCE vector and malformed,
unverified, oversized, redirected and unavailable-provider cases. The workspace
TypeScript and GitHub provider Bazel targets also pass.

This is provider infrastructure, not completed GitHub sign-in. Durable state and
encrypted verifier custody, callback/continuation handling, consent, explicit
account linking, Carbon MFA and session transactions remain to be composed and
verified. Sources and scope are recorded in the
[adapter README](../../../solutions/integrations/identity/github/README.md).

## 2026-09-12: durable GitHub account lifecycle

Composed the real GitHub adapter behind explicit account-provider configuration.
Registration, login and linking now persist encrypted state/verifiers, enforce
browser binding and consume state before a single provider exchange. The exact
cross-site callback exception creates a separate encrypted, one-time continuation;
it does not issue a Carbon session. Callback and completion independently recheck
expiry, linking session and security context. Start requests are durably limited
and deduplicated, and the worker erases expired payloads without requiring traffic.

Completion verifies Carbon MFA, commits failed-attempt counters, and atomically
consumes the proof with identity/session/audit changes. An existing email account
is never silently merged or linked. Explicit linking requires proof of both the
fresh Carbon session and matching verified GitHub email, with uniqueness for
provider subject and account. Later login follows the immutable provider subject
without silently changing profile/email. Linking revokes old sessions and rotates
the actor without extending absolute expiry.

Implemented live account identity listing and revision/CSRF/fresh-auth/MFA checked
GitHub unlinking. Unlinking requires a verified email fallback, preserves Carbon
MFA and revokes prior sessions/verified contexts. Migration 0012 preserves existing
subjects, adds durable flow storage and per-account GitHub uniqueness. Shared
contracts, generated types, provider configuration and endpoint OpenAPI are wired.

Verification: 182 tests across 18 files and 1,671 assertions passed in the combined
Cloud/identity/contracts/GitHub-provider run. After making linking CSRF responses
consistent with the other account APIs, nine affected GitHub/configuration/upgrade
cases passed with 176 assertions. Workspace TypeScript, generated-contract,
contract-conformance, account-auth and GitHub-provider Bazel targets all pass.
All 456 OpenAPI/shared-schema references resolve and scoped diff checks are clean.
Tests use real PostgreSQL and captured provider transports, not live consent or
production deployment evidence. Setup and remaining browser work are documented
in [github-account-authentication.md](github-account-authentication.md).

Pending before phase 1 can pass:

- Scoped project assignments/grants (including invitations),
  legacy organization claims and account deletion safeguards.
- Managed KMS/HSM custody and factor rewrapping/retiring-key migration. Keep all
  keys needed to decrypt pending or active enrolled factors in the meantime.
- Live authority/revocation protocol and independent Database/Registry assertion
  middleware, plus endpoint-specific OpenAPI and shared consumer tests.
- Production browser integration and the complete Slice 2 walkthrough, including
  multi-tab membership/stream revocation.

All later phases remain open: catalog/provisioning/outbox/audit, Database
isolation, production adapters, repository/secrets, Windows delivery/updater,
data/app auth/storage/realtime/functions/Registry/CLI, billing/operators/recovery,
deployment drills, and the Supabase-inspired Carbon frontend redesign.

## 2026-09-12: canonical scope authority and membership grants

Corrected the account permission matrix to distinguish role ceilings from
presets: Developer/Viewer data access and Admin signing require explicit grants;
empty assignments do not mean all projects. Owner/Admin organization name and
namespace updates are allowed, with MFA policy and ownership still Owner-only.
Production resource mutations require project policy, and resource/organization
lifecycle restrictions remove write permissions.

Migration 0013 adds canonical projects/environments, explicit membership project
access, assignments, grants and catalog command/event storage. Composite foreign
keys prevent cross-organization project, environment and membership relationships.
The upgrade preserves legacy organizations without inventing catalog records.

Composed GET scope-access and member-access endpoints against live PostgreSQL.
Added the revision/CSRF/fresh-auth checked `member-access` command with atomic
replacement, account/membership/organization revision changes and audit/outbox
receipts. Delegation checks actual canonical scope, target role ceiling and grant
expiry. Restricted administrators cannot escape their projects through all-project
assignment, broad grants, role changes, ownership proposals or Admin invitations.
Role downgrades prune ineligible grants; revocation/leave erase assignments and
grants, and re-invitation does not restore them. Invalid commands leave the old
configuration intact, and exact retries do not repeat mutations.

Verification: the combined Cloud/identity/contracts/GitHub-provider run passed
191 tests across 19 files with 1,870 assertions. After tightening UTC grant
timestamps and suspended-organization permission snapshots, three affected real
PostgreSQL access cases passed with 125 assertions. All 499 OpenAPI/shared-schema
references resolve. All seven Bazel targets pass, including the 22-project
workspace TypeScript gate, generated types, conformance, account auth, permission
policy, service assertions and GitHub provider. Scoped diff checks pass.
Provider tests remain captured transports; these are local
integration results, not production deployment evidence. Details and request
examples are in [platform-authorization.md](platform-authorization.md).

This adds canonical catalog storage and live scope checks, not completed catalog
provisioning. Project/environment creation and lifecycle APIs, binding sagas,
invitation assignments, downstream authority enforcement, stream revocation and
customer-data audit remain pending, along with the other phases listed above.
The full goal remains active; production cutover and the frontend redesign have
not been declared complete.

## 2026-09-12: durable canonical catalog and provisioning coordinator

Implemented the `@carbon/catalog` capability and composed its account HTTP API.
Project creation atomically stores a canonical project, development environment,
creator assignment, service binding intents, operation steps and audit event.
Environment creation, scoped listing/details, name/namespace changes, production
policy, archive/restore and pause/resume use live membership/grants, CSRF, fresh
authentication, revision checks and durable idempotency receipts. Production
creation checks prospective production authority and explicit namespace
confirmation. Service readiness remains distinct from lifecycle state.

Migration 0014 adds operations, steps, attempt history, binding constraints and
separate resource-authority revisions. The PostgreSQL worker leases one step,
rechecks current session and scoped authority, records independently completed
service work and fences stale completion after lease expiry. Retries preserve
successes and queue only incomplete steps; cancellation retains in-flight
successes. Configuration changes require review without deleting remote work or
activating an incomplete resume. Sibling progress does not invalidate execution
preconditions. Missing providers produce explicit capability failures.

Added a real signed HTTP lifecycle transport with pinned origins, exact
audience/scope/method/path/body binding, stable step idempotency, bounded responses,
redirect rejection and sanitized errors. Added the separate `catalog-worker`
entrypoint and explicit service-origin/Ed25519 self-hosted signing configuration.
The schema and API contracts include public catalog operations and the outgoing
owning-service lifecycle protocol. See [catalog-provisioning.md](catalog-provisioning.md).

Verification: the combined Cloud/identity/catalog/contracts/GitHub-provider run
passed 200 tests across 20 files with 2,088 assertions. An additional provisioning
migration adversarial case passed with eight assertions, checking preserved
catalog data, cross-scope operation/binding/step rejection, one active operation
per environment, and unique remote resource bindings. All seven selected Bazel
targets pass, including all 22 TypeScript projects. All 678 OpenAPI/shared-schema
references resolve; scoped diff checks pass.

Tests use real Cloud PostgreSQL, captured service ports and signed transport.
Database/Registry lifecycle receivers, native resource isolation and live
assertion middleware are the next integration work; end-to-end remote
provisioning is not yet proven. Lifecycle-status read endpoints, hosted signing
custody, event publication/streams, invitation assignments, legacy adoption,
deletion/retention, quotas and production browser work remain open. The full
cross-product/backend/frontend objective remains active.

## Local integration test service

Container: `carbon-platform-test-postgres`, Docker context `desktop-linux`,
port `127.0.0.1:55439`, database `carbon_platform_test`. It is separate from the
existing Cloud and Database service containers. The configured `dev` context's
remote host timed out; no changes were made to that host.

```powershell
$env:CARBON_PLATFORM_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55439/carbon_platform_test'
bun test products/carbon-cloud/tests/platform/migrations.integration.test.ts
```

The credentials above are only for this disposable loopback test service.
Tests create uniquely named test databases and clean up only those databases.
Production credentials and signing keys have not been requested or provisioned.

## 2026-09-12: owning-service lifecycle receivers and live authority

Database and Registry now expose opt-in signed lifecycle writes and metadata
status reads. Cloud independently inspects the original Ed25519 proof and checks
current account/session, scope, grants, MFA, resource revisions and, for writes,
the active operation/step/lease. Recipients pin issuer/audience/public keys,
consume replay in PostgreSQL, verify local ownership and repeat live authorization
before committing native resources, receipts and audit events. Signed lease IDs
fence stale requests while stable step IDs recover previously committed results
after response loss.

Database creates a canonical schema and restricted NOLOGIN role with native
object privileges; pause retains reads and removes writes, and resume restores
writes. Registry creates and updates a canonical scoped namespace. Both products
now use checksummed migration ledgers with serialized runners, unchanged legacy
baseline adoption and atomic pending migrations. Product entrypoints and HTTP
servers route the internal protocol; disabled configuration returns explicit
capability errors. Public-key trust and pinned Cloud authority configuration are
documented in [service lifecycle setup](service-lifecycle.md), with product-owned
environment examples and lifecycle/authority OpenAPI contracts.

Verification in this milestone:

- Real Bun HTTP servers and three independently migrated PostgreSQL databases
  exercised ensure/pause/resume, native role attributes and cross-schema denial,
  Registry state, replay, wrong audience, tampered scope, stale leases, durable
  retry after response loss, signed status-read revocation, and rollback of native
  DDL/grants when live authority changed before commit.
- Both owning-service migration tests passed concurrent baseline adoption,
  preservation of legacy records, checksum-drift rejection and rollback/recovery
  of a deliberately failing migration.
- Combined backend regression: **247 passing tests, 0 failures, 2,289 assertions
  across 29 files**, with both dedicated PostgreSQL test URLs configured.
- **Nine Bazel targets passed**, including workspace TypeScript, generated types,
  schema conformance, account/security/transport tests and new integration target
  wiring. Database-dependent cases skip in Bazel without the explicit environment;
  real database evidence comes from the separately configured regression above.
- Validated **691 local references across eight OpenAPI/schema documents** and
  passed the scoped whitespace/error check.

The dedicated pgvector service is `carbon-service-test-postgres` on loopback
55440 in Docker context `desktop-linux`. Tests clean up only their own randomly
named databases and generated roles. Handler recomposition was tested, not an
OS-process restart or production deployment.

Remaining isolation work includes restricted SQL connection identities and
execution rules, native RLS, application-user policies and migration of legacy
data routes. Schema ACL checks alone do not make arbitrary SQL safe. Registry
publishing still needs to consume canonical namespaces, and legacy signing/seed
behavior remains separate migration work. Hosted key custody, streams, invitation
assignments, adoption/deletion/retention, quotas, the other backend phases and
production browser work remain open. The full goal remains active.

## 2026-09-12: Database compatibility policy and ownership corrections

Inspection of BE-03's existing Database paths found permissive unknown policy
syntax, indefinite per-process policy caches, UPDATE checks against old rows only,
partial batch inserts, pre-commit notifications and project routes that trusted
caller-selected scope after token authentication. These paths now reject unsupported
policies, read policy state in the row transaction under shared/exclusive advisory
locks, check actual proposed rows, roll back batches atomically, and emit mutation
notifications only after commit. Policy deletion is scoped; table drops remove
policy/settings state in the same DDL transaction so replacement tables do not
inherit public access. A failed drop restores both table and policy state.

Legacy project routes now enforce local organization ownership before dispatch;
worker tokens cannot act as organization administrators and invalid credentials
cannot fall back to anonymous access. PostgREST routing parameters are separated
from filters, unsupported filter operators are rejected, and unsupported mutation
filters cannot silently broaden writes. Policy-context access requires explicit
RLS enablement. The [compatibility runbook](legacy-database-policy.md) documents
supported rules, behavior changes, test commands and remaining limits.

Verification: the combined backend regression passed **253 tests with 2,374
assertions across 31 files**. After the final table-drop cleanup change, the
Database suite passed **30 tests with 141 assertions across six files**, including
real PostgreSQL concurrency, trigger-modified rows, rollback and two-organization
route checks. Five selected Bazel targets passed earlier in the milestone,
including workspace TypeScript and the new policy test targets; PostgreSQL cases
were exercised separately with the dedicated test URL rather than inferred from
skipped Bazel cases.
Workspace TypeScript and both policy Bazel targets passed again after the final
table-drop change. The scoped whitespace/error check also passed.

This corrects the legacy compatibility implementation; it does not replace
canonical native RLS, restricted SQL execution or administrative data-access
auditing. Public realtime authorization and canonical application realm identity
remain unfinished. The existing raw-SQL connection still has administrative
privileges, and `search_path` is not tenant isolation. The full backend plan and
subsequent production frontend remain active work.

## 2026-09-13: canonical native table and policy adapter

Added `@carbon/data` with a validated definition/policy domain, trusted authority
port and real `PostgresNativeTables` repository. Database migration 0003 persists
canonical table identity, scope-bound metadata, revisions and redacted data audit
events. Product composition now supplies this adapter as `deps.nativeTables`.
The [native data runbook](native-data.md) documents the implemented boundary and
remaining API integration.

Tables use stable UUID-derived physical names inside provisioned environment
schemas, native ENABLE/FORCE RLS, an exact-scope restrictive policy and explicit
owner/public-read rules. Configuration rejects arbitrary SQL and unsupported
rules. Row operations execute generated parameterized DML under the environment's
restricted role with transaction-local identity, five-second statement/lock
timeouts, input/result limits and a native row-size constraint. Integer/decimal
values retain exact string representation. Policy and row updates use optimistic
revisions. Environment pause denies writes, and pooled identity resets at the
transaction boundary.

Live authority callbacks run before work and before commit. Failure rolls back
native DDL, policy changes, rows and audit events. Account policy previews are
distinct from app-user execution and audited without row payloads. This is an
internal trusted port: it does not itself verify signed tokens or establish an
application realm, and tests do not claim those missing transport integrations.

Verification used real PostgreSQL and two provisioned canonical environments:
native RLS flags, different users, foreign/missing scope, ownership transfers,
BEFORE-trigger changes, exact defaults/values, revision conflicts, public/disabled
policies, pause/resume, reconstruction, pooled-state reset, native row-size checks
and authority-revocation rollback. The combined native/migration/lifecycle run
passed **10 tests with 125 assertions**. The broader backend regression passed
**259 tests, 0 failures, 2,438 assertions across 33 files** with both dedicated
PostgreSQL URLs configured. **Five Bazel targets passed**, including workspace
TypeScript and native-policy/integration target wiring; database behavior was
verified by the separately configured Bun runs, not skipped Bazel cases. The
scoped whitespace/error check passed.

BE-03 and BE-08 remain incomplete. Next work includes signed canonical data HTTP
and Cloud forwarding, shared wire contracts, replay/idempotency receipts,
application-realm verification, full table/schema/query operations, separate
restricted raw SQL execution, failed-attempt auditing and realtime authorization.
Legacy APIs remain outside this adapter and still block production cutover.
The remaining backend phases and subsequent frontend work remain active.

## 2026-09-13: signed data requests and durable command receipts

Connected the native table repository to six signed Database POST operations:
table creation, policy replacement, row queries and row insert/update/delete.
Shared platform schema components and generated types now define data columns,
policies, requests, safe receipts and scope/binding/table-bound responses. Native
domain types reference those generated definitions. The
[signed data protocol](signed-data.md) and [OpenAPI](data-api.openapi.json) describe
the exact paths, headers, limits and currently supported account identity mode.

Database verifies the pinned signature, audience, principal, scope, exact path/body,
operation grant and correlation ID, consumes replay durably and checks live Cloud
authority. Cloud independently resolves current session, permissions, role/MFA,
assignment, lifecycle policy and confirmed Database binding for those exact paths.
Application-user assertions remain denied until realm/session verification exists.
Native ownership and row policies still execute independently inside Database.

Migration 0004 persists command receipts scoped to principal kind/ID and command
ID. A stable business digest prevents changed intent or scope from reusing that
ID. Command locking, native work, audit event and receipt commit together.
Receipts contain only IDs and revisions, never historical row payloads. Current
authority is required for every retry; a fresh assertion can recover a lost
response or concurrent duplicate without repeating the mutation. Revocation
before commit rolls back work and receipt together.

Added the actual `HttpDataClient` with canonical signing, pinned origins, redirect
rejection, deadlines, bounded responses, controlled errors, and response scope,
binding, table/command/row/correlation and pagination checks. Real HTTP integration
uses this client alongside direct adversarial requests against live Cloud and
Database servers. It verifies durable retries, concurrent deduplication,
reconstruction, receipt redaction, replay, wrong audience, tampered bodies,
stale permissions, native row-policy rejection and revocation rollback.

Verification: **262 backend tests passed, 0 failures, 2,544 assertions across
34 files**, with both dedicated PostgreSQL URLs configured. **Eight Bazel targets
passed**, including workspace TypeScript, generated contracts, conformance,
native/client tests and integration wiring. Database-dependent Bazel cases may
skip without explicit environment; the configured Bun run supplies that evidence.
Validated **834 local references across nine OpenAPI/schema documents** and passed
the scoped whitespace/error check. Sandbox dependency-resolution failures were
rerun with approved access and passed.

Remaining work includes browser-facing Cloud data forwarding, application realms,
the rest of the DataService catalog/schema/query contract, restricted SQL execution,
failed-attempt auditing, realtime authorization and the other backend phases.
Frontend production integration remains sequenced after backend completion. The
overall objective is still active; production cutover is not claimed.

## 2026-09-13: account-facing Cloud data forwarding

Added the same-origin account Data endpoint backed by `AccountData`, PostgreSQL
authority resolution and the real signed Database client. Cloud resolves the
canonical scope and confirmed binding, validates account session, CSRF, role/MFA,
current permissions and mutation revisions, and requires fresh authentication.
Live internal authority checks also reject mutations whose fresh authentication
expires before Database commits. Cloud releases its local authority transaction
before making the network request.

Shared schemas now define account data requests and pages. Row inserts carry the
current table revision, checked atomically against native metadata; table/policy
and row mutation revisions match browser `If-Match` headers. Commands retain the
durable receipt and idempotency behavior of the signed protocol. Account row
requests explicitly use audited native policy previews.

Row pages use authenticated encryption for 15-minute cursors bound to session,
authority revisions, scope, binding, table, preview identity and page size. Every
page rechecks current authority and policies. Configuration uses an explicit
Database origin and shared active Ed25519 signing configuration; omitted data
configuration returns a capability error. Added [setup and semantics](account-data.md)
and [OpenAPI](account-data-api.openapi.json).

Verification: **263 backend tests passed, 0 failures, 2,584 assertions across
34 files**, with both dedicated PostgreSQL URLs configured. The account forwarding
test invokes the Cloud handler with actual Database and authority HTTP transports;
it covers session/CSRF/origin, revisions, cursor access changes, stale grants and
freshness-expiry rollback of native DDL and receipts. **Nine Bazel targets passed**,
including workspace TypeScript, generated types and contract conformance. The
configured Bun run supplies database evidence where Bazel cases skip without URLs.
Validated **857 local references across ten OpenAPI/schema documents** and passed
the scoped whitespace check. The local Python reference check required approved
access after the sandbox could not launch Python.

Application realms, the remaining DataService catalog/schema/query capabilities,
restricted SQL, failed-attempt auditing, realtime authorization and the other
backend phases remain open. Frontend production integration remains sequenced
after backend completion; the overall objective is active.

## 2026-09-13: canonical table catalog and definition reads

Implemented `tables.list` and `table.get` across the shared wire schema, Cloud
account API, signed service client, live authority endpoint, Database receiver
and native PostgreSQL repository. Table summaries expose stable IDs, current
revisions, names, column counts and policy-enabled state. Details expose current
typed columns/defaults and policy definitions. Both require `metadata.read`
independently of row access, recheck live authority after retrieval and remain
available in paused environments. Application identities cannot use the metadata
port; metadata-only accounts cannot substitute that grant for row reads.

Lists use ascending table UUID keyset pagination with 1–100 summaries, a default
of 50, and lookahead to omit continuation on the final page. Migration 0005 adds
the canonical scope/UUID index. Cloud encrypts continuation IDs and binds cursors
to operation kind, current account authority, scope, binding and page size, with
15-minute expiry. The transport validates scope, bounds, ordering, duplicate IDs,
continuations and table identity. These pages read current catalog state rather
than promising a snapshot across concurrent changes.

Verification: **266 backend tests passed, 0 failures, 2,639 assertions across
34 files**, with both dedicated PostgreSQL URLs configured. New real PostgreSQL
and HTTP scenarios cover current policy revisions, metadata-only access,
cross-environment isolation, encrypted cursor misuse, paused environments,
application-principal rejection and authority revocation during retrieval.
The fixture retains an active organization owner when downgrading the account
under test. **Nine Bazel targets passed**, including workspace TypeScript,
generated types, conformance and integration wiring; the configured Bun run
supplies the database evidence. Validated **907 local references across ten
OpenAPI/schema documents** and passed the scoped whitespace check.

This completes the basic paginated canonical table catalog and current-definition
read path. Name filtering/sorting, the remaining schema/constraint and row-query
features, application realms, restricted SQL, other backend phases and subsequent
production frontend integration remain open. The full objective is active.

## 2026-09-13: table catalog search and ordering

Added literal case-insensitive name search and ascending/descending UUID or name
ordering to the shared catalog request, native PostgreSQL repository and Cloud
account forwarding. Name ordering uses fixed ASCII collation and UUID tie-breaking;
all search values and continuation values remain SQL parameters. Percent signs,
underscores and SQL-shaped strings are literal search text. Migration 0006 adds
the scoped name/UUID index. Arbitrary substring search remains a scoped scan
bounded by the repository statement timeout.

Name continuations retain the original name and UUID rather than resolving the
previous table again. Cloud encrypts both values and binds the cursor to normalized
search and order in addition to existing authority/scope/page-size bindings.
Changing search case preserves equivalent semantics; changing search or sort
rejects the cursor. The service client verifies filtered names, ordering,
duplicate IDs and complete matching continuation values. Concurrent catalog
changes remain documented as current reads rather than snapshot pagination.

Verification: **267 backend tests passed, 0 failures, 2,664 assertions across
34 files**, using both dedicated PostgreSQL URLs. Tests cover all four orders,
literal wildcard characters, case-insensitive filtering, deleted anchors,
missing name continuations, malformed provider pages and account cursor misuse.
**Nine Bazel targets passed**, including TypeScript and generated contracts.
Validated **909 local references across ten OpenAPI/schema documents** and passed
the scoped whitespace check. The initial sandbox TypeScript dependency failure
was rerun with approved linked-dependency access and passed.

The schema/constraint and structured row-query features, application realms,
restricted SQL, remaining backend phases and subsequent frontend integration
remain open. The full objective is active.

## 2026-09-13: structured row filters, projections and selected IDs

Added shared filter/selection schemas and a bounded PostgreSQL query compiler for
typed equality, inequality, ordering comparisons, literal text/array/JSON
containment and null tests. JSON paths use bounded parameterized path segments.
Queries combine up to 32 filters with AND, accept up to 100 projected columns
and 1000 selected UUIDs, and retain native row policies, live authority checks,
exact decimal/integer strings and bounded results. Empty projections retain only
row IDs/revisions; empty selected-ID sets return no rows.

Cloud forwards the selection through signed requests and binds filters, columns
and selected IDs into encrypted cursors. The client rejects unexpected projected
columns, unselected row IDs and duplicate/out-of-order rows. Filtering can use an
unprojected column without bypassing row policies. The documented query language
rejects unknown columns and unsupported operator/type combinations.

The integration tests exposed Bun raw-parameter array encoding that also affected
explicit array-valued inserts/updates. Added PostgreSQL array parameter encoding
for those values, selected IDs and JSON paths. Values containing commas, braces,
quotes, backslashes, empty strings and literal `NULL` now round-trip correctly.
All values remain SQL parameters; no user SQL or JSONPath expression is accepted.

Verification: **269 backend tests passed, 0 failures, 2,701 assertions across
34 files**, using both dedicated PostgreSQL URLs. Tests cover native policy
isolation, exact numeric comparisons, JSON path/type checks, containment/null
semantics, escaped arrays, empty selections, malicious-looking path values,
cursor selection changes and rejection of excess provider columns. **Nine Bazel
targets passed** after correcting two test type annotations and rerunning the
affected client and workspace TypeScript checks. Validated **919 local references
across ten OpenAPI/schema documents** and passed the scoped whitespace check.
The sandbox's linked-Ajv resolution failure was rerun with approved access.

Row sorting, remaining schema/constraint operations, imports/exports, application
realms, restricted SQL and other backend phases remain open. Production frontend
integration remains sequenced after backend completion; the full goal is active.

## 2026-09-13: typed row sorting and complete continuations

Implemented ascending/descending row sorting across all ten supported column
types through native PostgreSQL, signed transport and Cloud account forwarding.
Text/text-array ordering uses fixed collation, JSON uses JSONB order, SQL nulls
sort last in both directions, and ascending row UUID breaks ties. Integer and
decimal boundary values remain exact strings. JSON null and SQL NULL have distinct
continuation state. Filters, projections and native row policies still apply.

The new page port returns a continuation only when an authorized lookahead row
exists. Sorted boundaries preserve the original typed value, null flag, row UUID
and table revision. Cloud encrypts the boundary, including an omitted sort column,
and binds ordering into the cursor. Changed table revisions reject continuation;
deleted anchors do not require re-reading the original row. Large sort keys use
bounded 128-KiB encoded cursors. Internal responses allow 2 MiB plus 80 KiB while
returned row contents retain the 2-MiB limit. Pages remain current reads without
a cross-request snapshot guarantee.

Verification: **271 backend tests passed, 0 failures, 2,945 assertions across
34 files**, using both dedicated PostgreSQL URLs. Tests exercise every type in
both directions, exact decimals, UUID ties, multiple nulls, JSON null distinction,
hidden rows, omitted projections, deleted anchors, revision changes, malformed
sort continuations and account cursors above 4 KiB. **Nine Bazel targets passed**,
including workspace TypeScript, generated contracts and client/integration tests.
Validated **925 local references across ten OpenAPI/schema documents** and passed
the scoped whitespace check. The sandbox TypeScript dependency-resolution failure
was rerun with approved access and passed.

Schema/constraint operations, imports/exports, application realms, restricted SQL
and remaining backend phases are still open. Production frontend integration
remains sequenced after backend completion; the full objective remains active.

## 2026-09-13: schema previews and atomic table/column edits

Added shared schema-change/preview contracts and `table.preview`/`table.alter`
through Cloud, signed transport, live authority and Database. Previews require
metadata permission and return the current revision, proposed definition,
destructive flag and managed policy/primary-key references without scanning rows.
Mutations require fresh configuration authority and the current table revision;
column drops and type changes additionally require the current table name as
confirmation. Logical table renames retain stable native identities.

Column add/edit/drop supports typed defaults, nullability, native casts and owner
column renames. Managed policy and primary-key references follow column renames.
The repository rebuilds managed native policies and the complete row-size check
around the DDL, then commits metadata, audit and durable receipt in the same
transaction. Policy/primary-key dependencies and native constraints/indexes block
column drops. There is no implicit cascade. Failed casts, nullability checks,
revision races and authority loss roll back all work. Unsupported native casts
and dependency failures return controlled validation/conflict errors.

Verification: the full configured PostgreSQL regression passed **272 tests,
0 failures, 2,986 assertions across 34 files**. After the final cast-error handling
and input snapshot changes, the real cross-service API suite passed **7 tests,
172 assertions**, including a rejected UUID-to-boolean cast that leaves the
schema revision unchanged. Native tests cover preview immutability, policy and
primary-key rename preservation, exact values, confirmation, stale revisions,
receipt retries, dependency rejection, failed DDL and revocation rollback.
All **nine Bazel targets passed on the final code**, including workspace TypeScript
and generated contracts. Validated **974 local references across ten OpenAPI/schema
documents** and passed the scoped whitespace check.

Preview covers managed definitions, not complete native dependency discovery or
data conversion feasibility. These edits retain bounded synchronous DDL limits;
large asynchronous schema operations, remaining constraint/primary-key workflows,
imports/exports, application realms, restricted SQL and the other backend phases
remain open. The full objective is active; frontend production integration follows
backend completion.

## 2026-09-13: user primary-key changes

Added the `primary-key` schema change to previews and atomic commands. Adding a
key validates native uniqueness and NOT NULL; replacement/removal requires current
table-name confirmation. User keys remain managed UNIQUE plus NOT NULL constraints
while the internal UUID primary key and existing row identities stay unchanged.
Clearing a key preserves column nullability for a separate explicit schema edit.

New key constraints use stable table-specific names. Earlier canonical writers'
generated names remain compatible only when one valid, non-deferrable native
unique constraint exactly matches the catalog key and NOT NULL column. Missing
or ambiguous state fails for review. Foreign-key references prevent removing or
replacing a key; no dependencies are cascaded. Failed data validation or lost
authority restores the old key, nullability, metadata and command receipt state.

Verification: **273 backend tests passed, 0 failures, 3,022 assertions across
34 files**, with both dedicated PostgreSQL URLs configured. Tests cover adding,
replacing and clearing keys, duplicate/null data, confirmation, stable row IDs,
durable retries, referenced keys, earlier constraint names, ambiguous constraints,
revocation rollback and multiple keyed tables in one environment. All **nine Bazel
targets passed**, including TypeScript, generated contracts and integration wiring.
Validated **975 local references across ten OpenAPI/schema documents** and passed
the scoped whitespace check.

Remaining constraint/index and asynchronous schema workflows, imports/exports,
application realms, restricted SQL and other backend phases remain open. The
overall goal is active; production frontend integration follows backend completion.

## 2026-09-13: managed unique/check constraints and indexes

Added managed unique and scalar check constraints and B-tree indexes at table
creation and through `constraint.set`/`constraint.delete` schema commands. Stable
constraint IDs separate logical labels from native names. Rule replacements and
integrity-constraint removal require current table-name confirmation; label-only
edits preserve native objects and references. Column renames update descriptors,
while dependency-bearing column drops fail without cascading.

Migration 0007 records private descriptors and native signatures. Schema changes
verify this evidence before editing, reject native drift, and commit native DDL,
signature records, metadata, audit and durable receipts together. Failed data
validation, foreign-key dependencies and final authority revocation roll back
the entire change. Signature checking runs during schema edits; it does not
continuously monitor privileged external DDL.

Verification: **275 backend tests passed, 0 failures, 3,057 assertions across
34 files**, with both dedicated PostgreSQL URLs configured. Coverage includes
initial constraints, duplicate/check rejection, escaped literal values, failed
replacement and retry, column rename dependencies, referenced constraint label
edits, removal, revocation rollback and deliberate native drift. All **nine Bazel
targets passed**, including workspace TypeScript and generated contracts.
Validated **985 local references across ten OpenAPI/schema documents** and
passed the scoped whitespace check.

Index creation retains bounded synchronous DDL limits. Foreign-key management,
asynchronous/concurrent builds, imports/exports, application realms, restricted
SQL and the other backend phases remain open. The overall goal is active;
production frontend integration follows backend completion.

## 2026-09-13: generated TypeScript table artifacts

Added `table.types` to the signed Database transport and same-origin account data
API. It reads the authorized current table definition with `metadata.read`,
returns a bounded TypeScript artifact tied to the stable table ID and revision,
and optionally rejects a changed requested revision. Metadata-only accounts do
not need fresh authentication; scope isolation and final live authority checks
remain enforced. Cloud validates artifact identity, revision and safe filename.

Generated declarations cover all ten wire column types, exact integer/decimal
strings, nullability, defaulted insert fields, updates and selected row envelopes.
Fixed export names and quoted fields handle TypeScript keywords; optional
prototype-named fields support omission without inherited-property conflicts.
Source is deterministic and contains no row data, default/check literals or
credentials. Runtime value validation, constraints and policies remain required.

Verification: **277 backend tests passed, 0 failures, 3,092 assertions across
35 files**, with both dedicated PostgreSQL URLs configured. The first full runs
encountered closed connections because Docker Desktop was stopped; after starting
Docker and the existing test containers, the complete regression passed. The
real HTTP tests prove regenerated types after schema changes, stale-revision
conflicts, metadata-only reads, foreign-scope rejection and authority revocation.
Compiler tests check required/defaulted fields, exact numeric values, nullability,
projections, reserved names and bounded source. All **ten Bazel targets passed**,
including the new generated-source compiler target, workspace TypeScript and
generated contracts. Validated **1,009 local references across ten OpenAPI/schema
documents** and passed the scoped whitespace check.

The generated artifact is a metadata capability, not an application SDK or a
production browser cutover. Foreign-key management, asynchronous schema work,
imports/exports, application realms, restricted SQL and other backend phases
remain open. The full objective remains active; frontend integration follows
backend completion.

## 2026-09-13: typed import structure review

Added `rows.import-preview` through the signed Database and same-origin account
data APIs. It reads only the authorized table definition and caller-supplied
source, with optional schema revision pinning and final live metadata authority.
JSON/CSV parsing rejects duplicate JSON keys, ambiguous headers/mappings and
malformed quoting; mappings can explicitly drop fields. Typed validation
preserves exact integer/decimal strings, checks required columns/nullability and
retains omitted defaults for native evaluation during eventual execution.

Reviews are bounded to 256 KiB source, 1,000 rows, 100 distinct source columns,
20 valid samples and 100 safe row errors. CSV preserves quoted null literals,
delimiters/newlines and exact text. Responses explicitly identify structural
validation: they do not read existing rows, simulate policies/constraints or
create mutations, receipts or operations. Durable import execution and private
export/download jobs remain required work.

Verification: **282 backend tests passed, 0 failures, 3,175 assertions across
36 files**, with both dedicated PostgreSQL URLs configured. Parser tests cover
quoted delimiters/newlines, BOMs, null literals, exact numbers, required/defaulted
fields, duplicate/escaped JSON keys, prototype-named fields, malformed sources,
mapping collisions and all evidence limits. Real HTTP/PostgreSQL tests verify
revision conflicts, metadata-only access, foreign scopes, authority revocation
and unchanged command/audit state. Transport checks reject inconsistent counts,
sample/error row evidence and table/revision mismatches. All **eleven Bazel
targets passed**, including the new parser target, workspace TypeScript and
generated contracts. Validated **1,039 local references across ten OpenAPI/schema
documents** and passed the scoped whitespace check.

This increment completes structural review only. Durable import jobs must still
enforce live write authority, policies, native constraints, conflict behavior and
atomic/partial outcomes; private export jobs and the remaining backend phases are
also open. The full goal remains active, with frontend integration after backend
completion.

## 2026-09-13: native import execution and retry receipts

Added the trusted `applyImport` repository primitive and shared execution/result
components. It prepares the full bounded source, validates the table revision,
requires confirmation for updating imports and applies parameterized native
inserts/skips/upserts under the existing row-policy role. Defaults, stored-row
size and native constraints are evaluated by PostgreSQL. Upserts preserve row
identity and increment revision; duplicate source keys follow input order.

Atomic mode rolls back on any row error. Partial mode isolates expected row
failures with savepoints and reports complete totals with bounded safe evidence.
Unknown database errors, timeouts and final authority revocation still roll back
all effects. The existing command ledger and advisory lock commit rows, audit
counts and the receipt together. Separate connection pools and reconstructed
adapters reconcile retries without duplicate application or changed intent.

Verification: **286 backend tests passed, 0 failures, 3,228 assertions across
36 files**, with both dedicated PostgreSQL URLs configured. The final separate-
connection import checks passed **3 tests, 48 assertions**, covering all conflict
modes, native constraints and old/new policies, atomic/partial outcomes,
revocation rollback, unknown database failures, receipt identity, error truncation
and the 1,000-row bound. All **eleven Bazel targets passed**; workspace TypeScript
and the native target passed again after the final concurrency test change.
Validated **1,050 local references across ten OpenAPI/schema documents** and
passed the scoped whitespace check.

The execution primitive is deliberately absent from ordinary signed/account
request unions, with a contract test guarding that boundary. Import job enqueue,
lease-bound dispatch, polling, reconciliation and cancellation remain unfinished;
this does not expose a synchronous browser import replacement. Private exports
and the other backend phases also remain open. The full goal stays active.

## 2026-09-13: durable import jobs and user-requested handoff

Completed the bounded import workflow through Cloud's separate enqueue/status/
cancel API, envelope-encrypted PostgreSQL staging, persistent attempts and
cancellation receipts, and a separately runnable `data-import-worker`. Database
receives exact signed operation/lease/body requests and checks live Cloud job
authority before work and commit. Ordinary data request unions still reject the
native execution command.

Interrupted or reclaimed leases reconcile the native command receipt under the
same advisory lock before retry or cancellation confirmation. A lost reply after
commit recovers the original counts without applying rows twice. Cancellation
after commit preserves actual success; cancellation or authority loss before
commit rolls back the transaction. Metadata-only recovery remains possible after
write revocation. When session/security revocation prevents receipt inspection,
the operation explicitly reports `outcomeUnknown` and retains encrypted staging
for future operator review. Unknown-outcome repair and retention are still open.

Verification at this checkpoint: the selected regression suite passed **166
tests, 0 failures, 2,657 assertions across 22 files**, with both dedicated test
PostgreSQL URLs configured. Separate owning-service migration tests passed **2
tests, 18 assertions**. The three new real-service import scenarios cover browser
authority, encrypted staging, concurrent enqueue deduplication, partial results,
queued and in-flight cancellation, lost committed replies, stale leases, schema
conflict, write revocation and session-revoked unknown outcomes. The three
protocol tests additionally verify signed request binding, malformed/foreign/
oversized receipts and provider diagnostic redaction.

All **12 targeted Bazel checks passed**, including the new import protocol target,
all-workspace TypeScript and generated contract conformance. Database scenarios
were exercised in the direct runs above; default Bazel integration targets skip
their database cases without explicit URLs. Validated **1,149 local references
across 11 schema/OpenAPI documents** and the scoped whitespace check. This is
scoped evidence, not a claim that the entire workspace release gate is green.

The user explicitly requested a clean stop to switch to a less expensive model.
Implementation stops here; the overall platform objective remains unfinished.
The complete backlog, verified boundaries, key files, environment/test commands,
known risks and suggested next bounded task are in
[platform-handoff.md](platform-handoff.md). Frontend redesign has not begun.

## 2026-09-13: environment-scoped automation credentials

Added an environment credential contract, Cloud migration 0016, PostgreSQL
repository, account use case, exact nested HTTP routes and live credential
verifier. `ce_` tokens are returned only by the first successful create or
rotation response. Persistence keeps SHA-256 hashes, a short display prefix,
fixed automation audience, exact environment scope, bounded permissions and
expiry metadata. List results, command receipts, events and errors contain no
plaintext token or token hash.

Creation requires fresh `resources.configure` authority plus every delegated
permission at the exact environment and the current environment revision.
Rotation keeps the logical ID, uses the credential revision and permits at most
24 hours of overlap capped by the prior expiry. A later rotation removes older
overlap material. Revocation removes every overlap and is immediately enforced
by the verifier. Safe revoke retries return the original receipt; create and
rotate replay protection prevents duplicate issuance but deliberately refuses to
redisclose a token that Carbon no longer stores.

The focused real HTTP/PostgreSQL test passed **1 test with 35 assertions** across
issue, hash-only persistence, redacted projections/events, permission and tenant
scope checks, delegated-permission ceilings, rotation overlap, overlap expiry,
restart-safe idempotency and live revocation. The final affected contract,
catalog and Cloud PostgreSQL regression passed as part of **73 tests with 1,457
assertions across 4 files**. Contract and
both Solutions/Product TypeScript checks passed. **Four Bazel targets passed**,
including workspace TypeScript, generated types, conformance and catalog tests.
The earlier five-second invitation timeout passed on immediate focused rerun and
the final full run. Validated **1,212 local references across 12 schema/OpenAPI
documents** and the scoped whitespace check.

This completes the environment-credential foundation only. Versioned secrets,
personal/service-account/device/worker credentials, device authorization,
downstream assertion exchange, legacy credential migration and GitHub App
repository integration remain open BE-05 work. The overall backend and frontend
goal remains active.

## 2026-09-13: versioned environment secret custody

Added shared write-only secret contracts, Cloud migration 0017, immutable secret
versions, metadata projections, account use cases and exact environment routes.
Create and rotate accept up to 64 KiB after UTF-8 encoding and return only name,
scope, state, current version and revision. Disable/enable changes materialization
state without deleting version history. Idempotent retries return the same safe
receipt; names remain unique per environment.

Each version uses a random 256-bit data key and AES-256-GCM authenticated
encryption bound to its secret/version identity. A separate `SecretKeyCustodian`
port wraps data keys. The explicit self-hosted adapter has an independent
keyring, supports active-key rotation overlap and is configured separately from
account mail/import keys. The stored version records the wrapping key ID and
envelope; values, envelopes and key IDs never enter account responses, command
receipts, events or provider-safe errors. Hosted KMS/HSM custody remains a
deployment adapter rather than an in-process key claim.

The final affected regression passed **73 tests, 0 failures and 1,457 assertions
across 4 files**, including 31 PostgreSQL assertions for version creation,
decryption evidence, context tamper rejection, metadata-only listing, tenant
isolation, restart-safe retries, rotation, collision redaction, disable state and
CSRF. Separate crypto coverage verifies wrapping-key rotation and retired-key
failure. Both Solutions and Carbon Cloud TypeScript passed. **Four Bazel targets
passed**, including workspace TypeScript, generated types, conformance and catalog
tests. Validated **1,267 local references across 13 schema/OpenAPI documents**.

This completes versioned secret management and a replaceable custody boundary,
not worker delivery. Hosted KMS/HSM integration, retention/destruction rules and
short-lived build/function lease bindings remain required. GitHub App repository
integration is the next BE-05 slice; the overall backend and frontend goal stays
active.

## 2026-09-13: GitHub App repository foundation

Added shared installation, repository-binding, immutable-commit and webhook
contracts; Cloud migration 0018; a vendor-neutral provider port; PostgreSQL
repository/use case; exact account routes; and explicit environment composition.
The GitHub App adapter signs bounded RS256 JWTs, obtains ephemeral installation
tokens, discovers at most 1,000 repositories, revalidates access before every
provider-backed action and redacts provider failures. Persistence contains stable
provider identifiers and metadata only.

Project configuration requires fresh `resources.configure`, CSRF, an idempotency
key and the current project revision. Installation connect/refresh uses the
current organization revision. Ref resolution records one immutable lowercase
40-character SHA with the live repository revision. The webhook endpoint verifies
the HMAC over exact raw bytes, caps input at 1 MiB, deduplicates delivery IDs by
event and payload digest, refreshes installation access on every delivery and
disconnects projects whose repository is removed or archived. Raw payloads
and installation credentials are not stored.

The final affected regression passed **79 tests, 0 failures and 1,538 assertions
across 5 files**, including **28 real HTTP/PostgreSQL assertions** for identifier-
only storage, discovery, configuration, immutable resolution, removal
reconciliation and duplicate delivery handling. Both Solutions and Carbon Cloud
TypeScript passed, generated contracts were current, and **six affected Bazel
targets passed**. The focused GitHub adapter coverage includes signed JWTs,
ephemeral token use, live access checks, exact webhook authentication, provider
error redaction and its branch/commit/pull-request primitive.

The source-proposal route uses an actor/idempotency-derived branch and reconciles
an existing ref, desired file content and existing pull request before each write.
Its durable receipt excludes source content; retry after repository reconstruction
does not issue another provider proposal. Production GitHub App credentials and
evidence, broader credential principals/device flows and worker secret leases
remain open. The overall backend and frontend goal stays active.

## 2026-09-13: account-approved device and CLI credential foundation

Added shared device authorization, review, decision, polling and grant contracts;
Cloud migration 0019; a PostgreSQL repository; account use case; public device
endpoints; authenticated approval/list/revoke routes; composition; and a live
device credential verifier. The public endpoints pin the configured host, bound
JSON bodies to 8 KiB, reject foreign browser origins and use digest-keyed durable
request and polling limits.

Requests expire after ten minutes. Carbon stores only SHA-256 digests of the
random `dv_` device code and eight-character user code. Review requires live
`metadata.read`; approval additionally requires a fresh browser session, CSRF,
the current request revision and every delegated permission at the exact scope.
The first approved poll returns one `dc_` credential; later polls report consumed.
Persistence, pages, command receipts and events never contain that plaintext.

The verifier requires exact scope and permission, a live account, organization,
membership and scoped resource, an unexpired active grant, and the account's
current permission revision. Revocation clears the stored token hash. Decision
and revocation receipts are durable and idempotent across repository restart.
Invalid foreign-key scopes are returned as safe validation failures, and rare
generated-code collisions retry without committing rate-limit state.

The affected regression passed **85 tests, 0 failures and 1,639 assertions across
8 files**. The focused real HTTP/PostgreSQL lifecycle passed **36 assertions** for
pending/throttled polling, review, fresh approval, one-time disclosure, hash-only
persistence, exact scope/permissions, permission-revision invalidation, restart,
revocation, denial, expiry and invalid-scope handling. Generated contracts, both
Solutions and Carbon Cloud TypeScript, OpenAPI/schema JSON parsing and the scoped
whitespace check passed. All **11 affected Bazel targets passed**.

This foundation does not yet make CLI product commands consume `dc_` tokens or
exchange them for Database/Registry service assertions. Personal, service-account
and worker credentials, downstream exchange and legacy `cc_` migration remain
open. The overall backend and frontend goal stays active.

## 2026-09-13: managed service accounts and Database assertion exchange

Added strict service-account/account-credential/assertion contracts, migration
0020, a PostgreSQL repository, account use case, browser management routes and an
external credential-exchange route. Managed service accounts use one canonical
project or environment scope and a bounded delegated permission set. Distinct
`cs_` credentials are disclosed once, stored by SHA-256 hash, rotated with at
most 24 hours of predecessor overlap and rejected immediately after revocation or
account disablement. Updating or toggling an account advances its permission
revision, so enabling an account requires a newly rotated credential.

Migration 0020 extends the skeletal migration-0005 table without interpreting
legacy rows. Only explicitly managed accounts can be listed or authenticated, and
the new credential, overlap, command and event tables contain no plaintext token.
Durable retry receipts do not redisclose credentials that Carbon no longer stores.

With explicit assertion exchange enabled, Cloud authenticates one exact `cs_`
credential and returns a 60-second Ed25519 Database assertion bound to the
environment, permission, HTTP method, canonical path and body digest. The
receiving authority accepts the `service_account`/`automation` principal and
rechecks live Cloud state, including the managed account, credential, permission
revision, resource hierarchy and Database binding. Rotation overlap does not
widen the signed grant.

The affected regression passed **103 tests, 0 failures and 1,929 assertions
across 13 files**. Its focused real HTTP/PostgreSQL lifecycle passed **37
assertions** covering managed/legacy separation, one-time disclosure, hash-only
storage, exact scope and permission, rotation overlap, signed request binding,
live receiving-service authority, disable/enable invalidation, restart-safe
metadata, revocation and redacted durable evidence. Generated contracts, schema
and OpenAPI JSON parsing, and both Solutions and Carbon Cloud TypeScript passed.
All **15 affected Bazel targets passed**.

This chapter completes managed service accounts and their narrow Database
assertion exchange. Registry exchange, CLI consumption, automated row-policy
semantics, personal credentials, workers and legacy `cc_` reconciliation remain
open. Future work is split into independent goals in
[the phase-by-phase handoff](left-off/handoff.md); the overall platform goal stays
active.

## 2026-09-13: Phase 1 — CLI device login and Database assertions

Carbon CLI now completes the account-approved device flow with `carbon cloud
login`, including advertised polling intervals and terminal pending, denied,
expired and consumed states. The one-time `dc_` credential is stored through
`Bun.secrets` in the operating system credential store. Local profile metadata
contains the Cloud origin and grant only. `carbon cloud logout` removes the
secure credential and metadata.

The new `carbon db data` command accepts one strict platform `DataRequest` and
asks Cloud for a 60-second Database assertion. Cloud authenticates the `dc_`
credential, emits a distinct `account`/`cli` principal with no role claims, and
binds the assertion to the exact audience, environment, permission, POST path
and canonical-body digest. CLI forwards the same canonical body and correlation
ID to Database. Live Cloud authority checks the grant, account, organization,
membership, project, environment, permission revision and Database binding, so
revocation blocks both assertion exchange and consumption.

The affected regression passed **123 tests, 0 failures and 2,122 assertions
across 16 files**. The focused CLI suite passed **20 tests and 180 assertions**;
the focused real HTTP/PostgreSQL device lifecycle passed **44 assertions**.
Generated contracts and Solutions, Carbon Cloud and Carbon CLI TypeScript checks
passed. All **17 affected Bazel targets passed**. The platform schema and device
OpenAPI parsed as JSON, and scoped whitespace checks passed.

Phase 1 stops here. Registry assertion exchange is the next isolated phase;
personal credentials, workers, build execution and frontend work remain later
phases in [the handoff](left-off/handoff.md).

## 2026-10-10: Phase 2 — Registry assertion exchange

Device (`dc_`) and managed service-account (`cs_`) credentials can now be
exchanged for a 60-second assertion addressed to Carbon Registry. The exchange
is a separate contract and route per credential type
(`DeviceRegistryAssertionExchange` at `/platform/v1/device/registry-assertions`,
`ServiceAccountRegistryAssertionExchange` at
`/platform/v1/service-registry-assertions`). Each accepts only the
`carbon-registry` audience and a canonical `/registry/` POST path. The existing
Database exchange contracts are unchanged and still accept only
`carbon-database`.

Carbon Registry gained its first canonical account-facing request,
`namespace.get` (`RegistryRequest`/`RegistryResponse`, `metadata.read`), served
at `/internal/platform/v1/environments/{environmentId}/registry/namespace.get`.
It verifies audience, scope, permission, method, path, body digest and request
correlation, consumes the assertion once, and rechecks Cloud's live authority
before answering. Cloud's `PostgresServiceAuthority` routes `/registry/` paths
to a Registry-only check: `carbon-registry` audience, `account`/`cli` or
`service_account`/`automation` principal with no roles, one exact grant, a ready
or paused binding owned by Registry, and the current credential state. The
credential-state queries are now shared with the Database data check instead of
duplicated.

Proof gate, over real HTTP and PostgreSQL:

- A Database-audience assertion is refused by Registry (401), including one
  bound to the exact Registry request.
- A Registry-audience assertion is refused by Database (401 on a data path).
- Neither exchange route accepts the other's audience or path family (400).
- A Registry assertion naming the Database binding has no live authority (401).
- A replayed assertion is refused (401); a changed body or correlation ID is
  refused (400).
- Disabling the service account or revoking the device grant blocks both new
  exchanges and assertions already issued.
- Removing the audience check from the Registry authority makes the two Cloud
  credential tests fail, so the tests exercise the check.

The affected regression passed **491 tests, 0 failures and 4,340 assertions
across 60 files** (platform contracts, cloud identity/catalog/data capabilities,
integrations, Carbon Cloud, Database, Registry, CLI and the cross-service
suites). Generated contracts are current and the Solutions, Cloud, Database,
Registry and CLI TypeScript checks pass. Both changed OpenAPI documents parse as
JSON.

Not included: a CLI command that calls Registry, dashboard-session Registry
requests, and any Registry operation beyond `namespace.get`. Publisher, review
and trust work remains Phase 14.

Phase 2 stops here. Phase 3 (personal credentials and the legacy `cc_`
migration path) is next in [the handoff](left-off/handoff.md).

## 2026-10-10: Phase 3 — personal credentials and the legacy `cc_` path

**Personal credentials.** A signed-in account can create, list, rotate and
revoke `pt_` credentials at `/platform/v1/account/personal-credentials`. Each
carries one exact organization, project or environment scope and up to five
environment-credential permissions the owner holds there. The token is disclosed
once; only its SHA-256 hash and display prefix are stored. Expiry is required
and at most 90 days; an account can hold 20 active credentials. Creation and
rotation need a fresh session and re-check the delegated permissions.
`PersonalCredentialAuthentication` verifies a token for one exact scope and
permission against current account, membership, organization, project,
environment and permission-revision state. See
[personal-credentials.md](personal-credentials.md).

**Legacy `cc_` tokens.** Migration 0021 adds status, usage and retirement
columns to `api_tokens` without changing existing rows.
`CARBON_LEGACY_TOKENS` stages the deprecation: `issue` (default, unchanged
behavior), `accept` (legacy signup returns 410), `warn` (responses to
`cc_`-authenticated requests carry `Deprecation` and optional `Sunset`
headers) and `reject` (401). An account claims an unowned legacy organization
by presenting an active `cc_` organization token; no owner is inferred and an
organization with any member cannot be claimed. Owners with
`organization.manage` can list legacy tokens with last-use time, retire one
(optionally recording the replacing service account) and restore it. Retirement
keeps the hash, so it is reversible. See [legacy-tokens.md](legacy-tokens.md).

Proof gate, over real HTTP routes and PostgreSQL:

- One-time disclosure: a retried create or rotate is refused with 409; pages,
  receipts, events and command records contain no token or hash.
- Bounded scope: a credential is refused for a broader, narrower or foreign
  scope and for a permission it does not list; a Viewer cannot delegate
  `data.write`; organization management permissions are rejected by contract.
- Cross-tenant: a second account sees none of the first account's credentials
  and gets 404 for rotate, revoke, foreign scopes and foreign legacy tokens.
- Rotation and revocation: the old token stops at once; a lost membership,
  suspended organization, expiry or permission change ends the credential, and
  rotation cannot carry lost access forward.
- Migration: baseline legacy rows survive 0021 unchanged and active; a claim
  needs a valid token, CSRF and a fresh session, is idempotent, and cannot be
  repeated by another account holding the same token.
- Rollback: a retired token stops authenticating, keeps its hash, and works
  again after restore; each stage is covered by a route test.
- Removing the retired-token filter or the delegation check makes the new
  tests fail, so the tests exercise both.

The affected regression passed **498 tests, 0 failures and 4,485 assertions
across 60 files**. Generated contracts are current and the Solutions, Cloud,
Database, Registry and CLI TypeScript checks pass.

Not included: exchanging a personal credential for a Database or Registry
assertion, CLI use of personal credentials, deleting legacy hashes after a
published window, an operator view across organizations, and `wk_` worker-token
migration (Phase 4).

Phase 3 stops here. Phase 4 (worker enrollment, lease-scoped worker credentials,
hosted key custody and secret materialization) is next in
[the handoff](left-off/handoff.md).

## 2026-10-10: Phase 4 — workers, leases, hosted custody and secret delivery

**Enrollment and credentials.** Organization managers create a pending worker at
`/platform/v1/orgs/{orgId}/workers` and receive a single-use, 15-minute `we_`
code. The worker exchanges it at `/worker/v1/enroll` for a 30-day `wc_`
credential and can rotate that credential itself. Managers can disable, enable
and revoke workers. Codes and credentials are stored as hashes. The worker API
accepts worker credentials only and refuses requests with a browser Origin.

**Leases.** `WorkerLeases.grant`, callable only inside Cloud, creates a lease
for one subject, one environment and a named list of secrets. A worker of the
same organization, purpose and platform claims it and receives a one-time `wl_`
lease token, renews it by heartbeat and completes it. `WorkerLeases.cancel`
cancels a subject; `WorkerLeases.reclaim`, run by the new
`worker-lease-sweeper`, expires overdue leases and re-offers work a worker held
and lost as a new attempt with a new identifier and token.

**Secret delivery.** `/worker/v1/leases/{id}/secrets` decrypts the current
version of each secret the lease names, once, for the worker that holds the
lease. It is the only place a secret value is decrypted for delivery. Missing or
disabled secrets deliver nothing. Values are not stored or logged; the event
records names and versions.

**Hosted custody.** `AwsKmsSecretKeyCustodian` implements the existing
`SecretKeyCustodian` port with KMS `Encrypt`/`Decrypt`, the secret identity as
encryption context, a Carbon-key-ID to KMS-key keyring for rotation, and
hand-written AWS Signature Version 4. `CARBON_SECRET_CUSTODY=aws-kms` selects it
with no fallback to the local keyring. AWS KMS was chosen as the planning
default for the open "secret/signing key custody" decision; the port keeps
other providers possible.

Proof gate, over real HTTP routes and PostgreSQL unless noted:

- A worker receives only the secrets its lease names; another secret in the same
  environment is not delivered.
- A worker in another organization is never offered the lease and gets 404 for
  it even with the right lease token; a build-only worker is not offered a
  function lease; a platform requirement is honored.
- A browser session, a request with an Origin, and `dc_`, `cs_`, `pt_`, `ce_`
  and `wl_` bearer tokens are refused by the worker API. No account route
  returns a value.
- Replay: a second delivery for the same lease is refused; an enrollment code
  works once.
- Expiry and worker loss: an overdue lease is dead to its own token and its work
  is re-offered up to the attempt limit; an unclaimed offer lapses.
- Cancellation: the heartbeat reports it; the lease can neither deliver nor
  complete.
- Rotation: a rotated worker credential stops the old one at once; a rotated
  secret delivers its current version; KMS key rotation keeps old envelopes
  readable (adapter test).
- Custody failure delivers nothing and leaves the lease deliverable.
- Disabling, revoking, credential expiry and organization suspension all refuse
  the worker.
- The KMS signer reproduces the published AWS Signature Version 4 example.
- Removing the single-use, lease-token, expiry or cancellation guard makes the
  tests fail.

The affected regression passed **505 tests, 0 failures and 4,723
assertions across 61 files**. Generated contracts are current and the
Solutions, Cloud, Database, Registry and CLI TypeScript checks pass.

Not proven or not included: the KMS adapter has not run against a real AWS
account; nothing grants leases in production until build orchestration exists;
the legacy `wk_` tokens and legacy build queue are unchanged; enrollment and
worker calls are not rate limited; moving envelopes between custody modes is
not implemented.

Phase 4 stops here. Phase 5 (lifecycle gaps: streams, audit browsing,
archive/deletion/suspension/recovery, revocation propagation and adversarial
tenant coverage) is next in [the handoff](left-off/handoff.md).

## 2026-10-10: Phase 5 — lifecycle, audit, streams and tenant denial

**Unified event log.** Migration 0023 adds `platform_events`, written by
triggers on the eleven existing event tables inside the source transaction, and
by Cloud directly for system actions. Readers order by writing transaction and
sequence and read only below the oldest running transaction, so a cursor cannot
skip a late commit.

**Audit browsing and stream.** `GET /platform/v1/orgs/{orgId}/audit` lists
entries newest first with project and environment filters.
`GET /platform/v1/orgs/{orgId}/events/stream` is a server-sent event stream
with heartbeat, resumable cursors, a 15-minute lifetime and a terminal
`authorization_revoked` frame. Both need `audit.read`, re-resolve access on
every read, and bind cursors to the session, its permission revision and the
scope. See [audit-events.md](audit-events.md).

**State machines.** Environments (active, paused, deletion pending, deleted),
projects (active, archived, deletion pending, deleted) and organizations
(active, deletion pending, deleted; suspended by operators) now have scheduled,
recoverable deletion. `CatalogLifecycle`, `OrganizationLifecycle` and the new
`lifecycle-sweeper` make due deletions final by marking rows. See
[resource-lifecycle.md](resource-lifecycle.md).

**Revocation propagation.** Every credential type is refused when its
organization is suspended, its project archived, or its environment scheduled
for deletion or deleted, and works again after recovery. A gap was closed:
`cs_` and `ce_` verification and the service authority for `cs_`/`dc_`
assertions accepted any environment that was not finally deleted; they now
require active or paused.

Proof gate, over real HTTP routes and PostgreSQL:

- Each state machine is walked in order, including every refused out-of-order
  step, the read-only behavior while deletion is pending, recovery, final
  deletion, and project deletion taking its environments with it.
- A credential matrix covers `pt_`, `ce_`, `cs_`, `dc_` and worker leases
  across suspension, archive, pending deletion, recovery and final deletion.
- Audit listing is ordered, paginates without gaps or repeats, filters by
  scope, and is refused to other tenants, Viewers and unassigned Developers.
- The stream delivers only new events in order, sends heartbeats, resumes from
  a cursor without loss, never shows another organization's events, closes at
  its lifetime, and ends with `authorization_revoked` when access changes.
- A two-tenant matrix of 69 reads and changes returns only 403 or 404, leaks no
  name, identifier or secret, and leaves the other tenant unchanged.
- Reverting the deletion-pending fix, removing the audit permission check or
  removing the pause-before-delete rule makes the tests fail.

The affected regression passed **509 tests, 0 failures and 4,954
assertions across 61 files**. Generated contracts are current and the
Solutions, Cloud, Database, Registry and CLI TypeScript checks pass.

Not included: an operator HTTP surface for suspension; destroying owning-service
data after final deletion; backfill of events before 0023; account-level
security events in the organization log; event retention and export; an
external broker; automation credentials are still accepted while an environment
is paused.

Phase 5 stops here. Phase 6 (application authentication realms, app users,
identities, providers, challenges and sessions) is next in
[the handoff](left-off/handoff.md).

## 2026-10-10: Phase 6 — application authentication

**Realms.** Each environment can have one realm, configured by developers at
`.../environments/{id}/realm`: signup policy, email sign-in, session lifetime,
an exact-match redirect allowlist, OIDC providers, disable, and realm-wide
session invalidation. Developers list, suspend, restore and delete app users and
revoke their sessions.

**App-facing API.** Under `/app/v1/realms/{realmId}`: public configuration,
generic emailed sign-in links, single-use link exchange, opaque `aps_` sessions
with rotation and sign-out, OIDC authorization code with PKCE, and exchange of a
session for a request-bound Database assertion. See
[app-authentication.md](app-authentication.md).

**Database access.** An app session exchanges for a 60-second assertion with an
`app_user` principal and a realm-carrying scope, limited to `data.read` and
`data.write`. Carbon Database accepts it for row operations only, takes the
realm from the signed token, and Cloud's live authority re-checks the session,
user, realm, claims revision and resource state. Row policies run with the
verified user ID.

**Supporting changes.** `PostgresProviderSecretReader` lets Cloud read an OIDC
client secret by name for its own token exchange. The mail worker also delivers
app sign-in links from a separate encrypted outbox. App events join the
organization log.

Proof gate, over real HTTP routes and PostgreSQL, the last group against the
real Carbon Database service:

- Signup policy: with signup closed an unknown address gets the same 202 and no
  mail; a known and an unknown address get byte-identical answers.
- Magic links are single use, hash-only, bound to their realm and to the claims
  revision, and sent only to the exact allowed redirect.
- Rate limits: five links per address (then silence), twenty requests per caller
  (then 429), with no address stored.
- Sessions: rotation stops the old token without extending the session;
  sign-out, expiry, suspension, deletion, realm disable and realm-wide
  invalidation each end access; restore does not revive old sessions.
- OIDC: a wrong state, an unverified email, a wrong nonce, audience or issuer, a
  forged signature, an expired token and a refused code are each rejected and
  spend the state; the provider receives a PKCE verifier matching the challenge
  and the stored client secret; a returning subject and a verified address map
  to the same user; no provider detail appears in public configuration.
- Tenant isolation: another developer gets 404 for the realm and its users; a
  session or link from one realm is refused by another.
- Database: two app users each read and write only their own rows; planting a
  row for another user is refused; schema, listing and policy preview are
  refused; the assertion cannot be replayed, altered or sent to Registry; sign
  out, suspension and claims-revision change each stop an assertion already
  issued; a developer session cannot use the application access mode.
- Seven mutation checks (live user state, claims revision, app permission
  limit, OIDC nonce, OIDC verified email, redirect allowlist, single-use link)
  each make a test fail.

The affected regression passed **524 tests, 0 failures and 5,243
assertions across 62 files**. Generated contracts are current and the
Solutions, Cloud, Database, Registry and CLI TypeScript checks pass.

Not included: passwords, passkeys and MFA for app users; custom claims and
roles; user export; CORS for browser callers on another origin; app users in
Registry; migration of the legacy organization-wide end users; a run against a
real OIDC provider.

Phase 6 stops here. Phase 7 (build orchestration: immutable source snapshots,
quota reservations, attempts, leases, heartbeats, cancellation and ordered logs)
is next in [the handoff](left-off/handoff.md).

## 2026-10-10: gap closures after Phase 6

Six items that earlier phases listed as not done:

- **Personal credential exchange (Phase 3).** `pt_` credentials exchange for
  request-bound Database and Registry assertions at
  `/platform/v1/personal/assertions` and `/platform/v1/personal/registry-assertions`,
  behind `CARBON_PERSONAL_ASSERTIONS`. Cloud's live authority recognizes a
  personal credential as an account acting through a tool and re-reads it.
- **CLI Registry command (Phase 2).** `carbon cloud namespace` calls Registry's
  `namespace.get` through the Registry-only device exchange.
- **Worker enrollment limit (Phase 4).** Ten attempts per caller per 15 minutes,
  counted before the code is examined, with no address stored.
- **Event backfill (Phase 5).** Migration 0025 copies events from before 0023
  into `platform_events`, in order and behind everything recorded since.
- **Browser origins for apps (Phase 6).** The app API answers CORS for the web
  origins of a realm's allowed redirect URIs and never allows credentials.
- **Paused environments (Phase 5).** `cs_` and `ce_` credentials are read-only
  while an environment is paused, both at verification and in the live authority
  check, so a write assertion issued before the pause stops being current.

Each has a test over real routes and PostgreSQL, and six mutation checks (paused
write at verification and at authority, revoked personal credential, enrollment
limit, origin check, backfill position) each make a test fail.

The affected regression passed **530 tests, 0 failures and 5,329
assertions across 62 files**. Generated contracts are current and the
Solutions, Cloud, Database, Registry and CLI TypeScript checks pass.

Still open from earlier phases, with the reason:

- A run against a real AWS account and a real OIDC provider: needs accounts.
- Destroying owning-service data after final deletion: needs a delete action in
  the Database and Registry lifecycle protocol.
- An operator route for suspension: Phase 16.
- A production caller for worker leases, and retiring `wk_`: Phase 7.
- Deleting legacy `cc_` hashes after a published window: needs the window
  decided.
- Custom claims, passwords, passkeys and MFA for app users; migrating the legacy
  organization-wide end users; event retention and export: not started.

## 2026-10-10: Phase 7 — build orchestration

**Builds.** `POST .../environments/{id}/builds` stores a canonical, digested
input (commit, targets, secret names, platform), reserves 30 minutes of the
organization's monthly build minutes, and grants the worker lease, all in one
transaction. This is the first production caller of worker leases. Developers
list builds, read details and logs, and cancel.

**Worker protocol.** On a held build lease a worker fetches the input (which
starts the attempt), appends ordered log segments, declares artifacts and
reports the outcome. Completion ends the lease, the attempt and the build
together and settles quota from the time attempts actually ran.

**Recovery.** A lost worker's lease is re-offered by the lease sweeper as the
next attempt, up to three; the sweeper then fails builds with no lease left
(`worker_lost`, `no_worker`) or past their deadline (`deadline_exceeded`).
Cancellation cancels the lease first. See [builds.md](builds.md).

**Structure.** HTTP route files moved from `presentation/http/` to
`infrastructure/http/` in Cloud, Database and Registry, following the rule that
`presentation/` is UI only. A gap ledger, [gaps.md](left-off/gaps.md), now
tracks every open item.

Proof gate, over real HTTP routes and PostgreSQL:

- **Immutable input:** every attempt receives the stored input and digest;
  direct SQL updates to the input, to a finished state, and to stored logs and
  artifacts are refused by triggers.
- **Duplicate commands:** a retried create returns the same build and creates
  one row; a retried cancel returns the same receipt; a different request under
  the same key is refused.
- **Quota:** two racing requests for the last slot produce exactly one build;
  a finished or cancelled build frees its reservation; used minutes are recorded
  from attempt time.
- **Log ordering:** out-of-order and rewritten segments are refused, an
  identical retry is accepted, the sequence continues gaplessly across attempts,
  and platform credentials are redacted.
- **Artifacts:** an unknown target, a path traversal key and a changed
  declaration are refused; success needs every target; a lost attempt's
  declarations are not outputs.
- **Lost and reclaimed workers:** the same input runs as attempt two on a new
  lease, the lost worker is refused everywhere, and three lost attempts fail the
  build as `worker_lost` with nothing left reserved.
- **Cancellation, reported failure, no worker, deadline:** each ends the build
  in the right state; a cancelled or timed-out build cannot be reported
  successful; a reported failure is not retried.
- **Authorization:** another organization gets 404; a Viewer can read but
  neither create nor cancel.
- Eight mutation checks (quota, log order, log rewrite, all targets, lease
  cancellation, lost-attempt artifacts, lost-attempt marking, redaction) each
  make a test fail. A ninth guard, refusing work on a finished build, is not
  independently reachable because the lease check refuses first.

The affected regression passed **562 tests, 0 failures and 5,534
assertions across 65 files**. Generated contracts are current and the
TypeScript checks pass for all projects.

New gaps are G-27 to G-35 in the ledger. The main ones: Cloud does not verify
declared artifacts against object storage, no worker runtime speaks this
protocol yet, and the legacy `wk_` queue is still separate.

Phase 7 stops here. Phase 8 (disposable Windows x64 execution, dependency locks,
NSIS/WiX packaging, signing and provenance) is next in
[the handoff](left-off/handoff.md).

## 2026-10-10: Phase 8, build execution (partly complete)

Phase 8 made a build real on both sides of the lease, as far as this machine
allows. It is **not** reported as complete: its proof gate asks for a clean
Windows worker under resource and egress limits producing real installers, and
that part is unproven (G-36 to G-38).

What was built:

- **Cloud verifies artifacts.** Before a build can succeed, Cloud reads every
  declared object back from object storage and compares its size and SHA-256.
  Object keys must be under `artifacts/{buildId}/{attempt}/`. The worker must
  report the commit it actually built, and it must be the commit in the input.
  `CARBON_WORKERS=enabled` now requires the `OBJECT_STORE_*` settings.
- **Provenance.** Migration `0027_build_provenance.sql` stores one append-only
  record per succeeded build: input, reported materials (resolved commit,
  lockfile digest, configuration digest, tool versions), verified artifacts,
  the statement digest and an optional Ed25519 signature. Read with
  `GET .../builds/{id}/provenance`; checked with `verifyBuildProvenance`.
- **The build input names its repository.** `repositoryUrl` is required,
  `https://` only, with no embedded credentials, and is part of the digest.
- **A worker runtime** in `solutions/capabilities/cloud/worker`:
  `RunLeasedBuildUseCase` with `HttpBuildProtocol`, `GitSourceCheckout`,
  `DisposableWorkspaces` and `CarbonBuildPipeline`, and the entry point
  `products/carbon-cloud/composition/build-worker.ts`. It clears the workspace
  root before claiming, checks out the exact commit, requires a bun lockfile,
  redacts secrets from logs before sending, uploads and declares, erases the
  workspace, and only then reports success. Documented in
  [build-worker.md](build-worker.md).

Proof, over the real worker and account HTTP handlers and PostgreSQL:

- **A whole build by the real runtime:** the worker enrolls through its own
  client, claims, checks a real git repository out at a pinned commit, runs a
  stand-in pipeline, uploads, declares, erases and completes. Cloud's record
  then shows the artifacts, a signed provenance whose lockfile digest equals the
  repository's, and a log with the secret and the worker credential redacted.
- **Refusals by the worker:** a commit without a lockfile and a commit the
  repository does not contain fail before any project code runs; an installer
  written outside the workspace is not uploaded.
- **Refusals by Cloud:** an artifact declared but not stored, stored with
  different bytes of the same size, or stored at a different size; a key outside
  the build and attempt (another build's, a later attempt's, a lost attempt's);
  a built commit that is not the input's; and unreachable storage (503, build
  still running).
- **Nothing left behind:** the workspace root is empty after success, every
  failure and cancellation, and leftovers from a simulated crash are removed
  before the next claim. A workspace that cannot be erased is reported as a
  failure, never a success.
- **Cancellation** reaches the running worker through its heartbeat; it stops,
  erases and reports nothing.
- **Provenance** verifies with the right key and fails for a changed statement,
  a changed digest, another key, another key identifier and a missing
  signature; the stored record cannot be updated or deleted by direct SQL.
- **Real object storage:** the worker's uploader and Cloud's verifier agree
  against a local MinIO container, including a same-size replaced object. This
  test needs `CARBON_OBJECT_STORE_TEST_*` and does not run in CI (G-44).
- Fourteen mutation checks each make a test fail: no redaction, commit mismatch
  ignored, lockfile not required, success without erasing, workspace never
  erased, outputs outside the workspace, reset not clearing leftovers,
  cancellation ignored, artifacts not verified, key prefix not enforced, built
  commit not compared, a wrong provenance signature, and the verifier ignoring
  the digest or the key identifier. The MinIO test was not mutation-checked.

The affected regression passed **578 tests, 0 failures and 5,728 assertions across 67 files**. Generated contracts are
current and the TypeScript checks pass.

Closed: G-27 (artifact verification), G-31 (secret redaction), G-35 (worker
runtime). New: G-36 to G-49. The ones that keep Phase 8 open are G-36 (no real
NSIS or WiX build has run), G-37 (Authenticode never run) and G-38 (no
isolation or resource limits). G-42 matters for security: workers can write
anywhere in the artifact bucket and objects are verified once.

Phase 8 stops here, partly complete. Finishing it needs a Windows build host
with NSIS, WiX and a signing certificate. Phase 9 (releases) is next in
[the handoff](left-off/handoff.md) and does not depend on those.

## 2026-10-10: Phase 9, releases, channels and updater conformance

Phase 9 turned verified build artifacts into releases that installed apps can
be offered, and made every updater decide the same way.

**Updater conformance.** `solutions/contracts/update/fixtures/conformance.json`
is generated from the publisher's own manifest builder and serializer and signed
with a fixed test key. It holds 8 signature cases, 20 version orderings and 17
invalid versions, 72 rollout buckets and 22 decisions. Three consumers run it:

- the TypeScript updater (`@carbon/updating`: `compareVersions`, `decideUpdate`,
  `verifyUpdateSignature`);
- the Rust updater packaged apps use (`carbon_updater::decide`, `version`),
  which the runtime's background updater now calls;
- the standalone updater (`products/carbon-updater`), which now delegates to
  `@carbon/updating`.

Before this the three disagreed. The standalone updater bucketed rollouts
without the version, accepted a manifest with no signature and ignored
`min_version`. The runtime updater ignored `min_version` and treated any
different version as an update, so a channel moved back would have downgraded
installs. Those are fixed by construction: each now has one decision function
with the checks in a fixed order.

**Releases and channels in Cloud** (migration `0028_releases.sql`,
[releases.md](releases.md), [release-api.openapi.json](release-api.openapi.json)):

- Signing profiles bind an environment secret that holds an Ed25519 key; only
  the public key is recorded.
- A release is made from a succeeded build. Cloud reads each chosen artifact
  back, checks it against the build's digest, signs it, and stores immutable
  metadata. A version is used once per environment.
- A channel moves by `publish` and `rollout`. Each move is a new immutable
  revision with its own signed manifest; promotion does not touch the release.
- Withdrawal adds the release to the stop list and moves every channel that
  offered it back to its last published release, in one transaction.
- A public feed serves `manifest.json`, `manifest.sig` and `yanked.json` per
  channel at an unguessable address, in the layout the Rust updater already
  fetches.

Proof, over the real HTTP handlers and PostgreSQL:

- **End to end:** two builds through the worker protocol, two releases, two
  channels. The manifest served by the public feed verifies under the profile's
  key, is byte-for-byte what was signed, and is fed to the updater's own
  `decideUpdate`: in and out of a 25% rollout, channel mismatch, compatibility,
  promotion, and after withdrawal a rollback for an install on the withdrawn
  version and 1.0.0 for an older one.
- **Refusals:** an unfinished build; an artifact changed or missing in storage;
  storage down (503); a signing secret replaced with another key; a reused
  version; a withdrawn release offered again; a channel moved from a stale
  revision; a rollout on a channel that offers nothing.
- **Immutability:** direct SQL updates to a release, a withdrawal, release
  artifacts, channel revisions and signing profiles are refused by triggers.
  Promotion and rollout leave the release row identical.
- **Authorization:** a Viewer reads and cannot write; another organization gets
  404 everywhere; binding a key needs `signing.manage`.
- **Secrets:** the private key appears in no release, revision, event or
  command row.
- **Mutation checks:** 28 deliberate breakages each make a test fail: 9 in the TypeScript updater, 2 in the standalone updater, 6 in the Rust updater and 11 in the release code (artifact digest, replaced signing key, unfinished build, withdrawal not moving channels, falling back to a withdrawn release, stale channel revision, re-offering a withdrawn release, a paused feed, signing and publishing permissions, and served manifest bytes). Three of the release guards are checked in two places; for those, both had to be removed before a test failed.

The affected regression passed **675 tests passed, 1 skipped (the object-store test, which needs a configured store) and 0 failed, with 6,455 assertions across 82 files. The set is wider than before: it now includes the distribution capabilities and the standalone updater**. Generated contracts and
the conformance fixture are current, the TypeScript checks pass, and the Rust
updater's 18 tests pass. The runtime compiles with the `updater` feature.

**A correction to earlier entries.** While adding Bazel targets I found that CI
has no database: the PostgreSQL-backed suites skip their database scenarios
there (G-50). "CI green" in earlier entries is true but covers typechecks, lint,
unit, contract and conformance tests and the Rust build, not the database
scenarios. Those have been run on the development machine only. Phase 9 adds
four targets CI does run: the three conformance suites and the fixture
freshness check. The Rust updater's tests had never run in CI before.

New gaps are G-50 to G-63. By the owner's decision the open decisions and
everything earlier phases could not finish are now collected into a final
Phase 19 rather than blocking phases as they come up.

Phase 9 stops here. Phase 10 (relational exports, foreign keys, impact previews,
asynchronous schema work, migration promotion and restricted SQL) is next in
[the handoff](left-off/handoff.md).

## 2026-10-11: Phase 10, relational data (partly complete)

Phase 10 built two of the things its plan line names and none of the other
three. It is reported as **partly complete**.

Built:

- **Foreign keys.** A managed constraint of kind `foreign-key`: one column that
  must hold a value of another table's primary key in the same environment, as
  a native PostgreSQL foreign key with no cascading
  ([native-data.md](native-data.md)).
- **Impact previews across tables.** A schema preview of a change to a
  referenced primary key lists every referencing constraint and is marked
  `blocked`; applying it is refused until those foreign keys are removed.
- **Private exports.** Durable Cloud jobs that page a table's rows out of
  Database under the creator's live authority, store them as parts in a private
  bucket with a checkpoint per part, and are downloaded through a single-use,
  60-second address ([data-exports.md](data-exports.md), migration
  `0029_data_exports.sql`).

Not built: restricted SQL, migration promotion, asynchronous schema changes, and
table deletion (G-64 to G-67).

Proof for foreign keys, against real PostgreSQL through the native-table
repository: a reference must be to a table in the same environment with a
primary key of the same type; orphan inserts and updates, and deletes or re-keys
of a referenced row, are refused; adding a link to a table with violating rows
changes nothing; a key change on a referenced table is blocked and previewed
with the referencing constraints, and goes through once they are removed; a
referencing column can be renamed and stays enforced; a table can reference
itself; and a native constraint altered behind the catalog is detected.

Proof for exports, over the real Cloud account API, the real Database service
over HTTP, and PostgreSQL, with 10,203 rows:

- **Authorization:** session, CSRF, origin, command identity and a recent
  authentication to start; a member without data access can do nothing; a
  colleague with full access can read the status but not download; a job whose
  creator's session ends fails at its next claim without contacting Database;
  Database independently refuses a job whose principal is no longer current.
- **Resumability and large-job recovery:** the export takes several claims; a
  storage outage leaves the uncounted part uncounted and the job waiting; a
  worker killed between writing and recording a part is replaced after its lease
  expires, and the new worker rewrites the same object. The file has exactly the
  10,203 rows the creator may read, each once, in order, and none of the seven
  rows that belong to someone else.
- **Cancellation:** immediate when no worker holds the job, at the next
  checkpoint when one does; stored parts are then deleted.
- **Downloads:** one use, 60 seconds, creator only, authority rechecked at use,
  a refused attempt spends the address, and only the token's hash is stored.
- **Consistency:** a schema change part-way fails the export; an expired export
  is not downloadable and its objects are deleted.
- **Format:** exact decimal strings, CSV quoting, and a guard against
  spreadsheet formulas in text cells.
- **Mutation checks:** 29 deliberate breakages each make a test fail: 8 for foreign keys (key change while referenced, the blocked flag, inbound dependencies, the primary-key and type rules, preview validation, cascading, inbound lookup) and 21 for exports (authority at claim and at download, token reuse and expiry, creator-only download, readiness, freshness, the data permission, the in-progress limit, cancellation at checkpoint, lease exclusivity, resume position, schema change, deterministic part keys, store-before-checkpoint, outage handling, the sweep, the formula guard and CSV quoting). Lease exclusivity is enforced in two places, and both had to be removed before a test failed.

The affected regression passed **679 tests, 0 failures and 6,661 assertions across 83 files, with the two object-store tests run against a local MinIO container**. Generated contracts are
current and the TypeScript checks pass.

One finding outside the feature: on Bun 1.3.10, `await expect(promise).rejects`
can hang forever when the promise's work uses `Bun.SQL`. The tests capture the
error with `.then` instead.

New gaps are G-64 to G-75.

Phase 10 stops here, partly complete. Phase 11 (blob storage) is next in
[the handoff](left-off/handoff.md).

## 2026-10-11: Phase 11, blob storage

Phase 11 added canonical blob storage, owned by Carbon Database and reached
through Cloud's account API ([blob-storage.md](blob-storage.md),
[blob-api.openapi.json](blob-api.openapi.json), Database migration
`0008_blob_storage.sql`).

- Buckets with visibility, a size limit, allowed content types, versioning,
  retention, a quota and a revision.
- Uploads and downloads through single-use addresses. An upload address is for
  one exact object (key, size, SHA-256, content type); what arrives is verified
  before anything is stored. Bytes are raw, never base64 or JSON, and never pass
  through Cloud.
- Public download that reads the bucket's visibility at the moment of the
  request.
- Versions, restore, and retention-based removal.
- A quota that counts stored versions and uploads still in flight.
- Cleanup for lapsed addresses, abandoned uploads and expired versions.
- Metering rows that cannot double count.
- Cloud's live authority now recognizes blob requests, with their own paths and
  permissions; app users are refused.

Proof gate, over the real Cloud account API, the real Database service over
HTTP (including the byte transfers themselves) and PostgreSQL:

- **Two-tenant upload, download and delete:** a second environment cannot see,
  read, write, restore or delete anything of the first, by ID or by name, and
  may reuse bucket names and keys. A member without data access can list and
  nothing else; a stranger to the organization sees nothing. Stored keys are
  opaque and contain the owning environment.
- **Exact bytes:** all 256 byte values round-trip unchanged.
- **Interrupted transfers:** wrong bytes of the right size, a short body, a long
  body, a wrong content type, no body, and a storage outage are each refused,
  store nothing, and spend the address. An upload that died after its bytes
  reached storage is found by cleanup and its bytes deleted.
- **Expiry:** unused upload and download addresses stop working and are closed.
- **Quota:** two racing uploads for the last space produce exactly one address;
  the limit is exact to the byte; lapsed reservations and purged versions give
  space back.
- **Orphan cleanup:** abandoned uploads, versions past retention, permanently
  deleted versions and every byte of a deleted bucket are removed, and the
  bucket's usage returns to zero.
- Also: versions and restore, public visibility flips, a paused environment, a
  mid-request revocation, idempotent receipts, and metering counts.
- **Mutation checks:** 31 deliberate breakages were tried. 27 make a test fail: cross-environment access by ID, reuse and expiry of upload and download addresses, an upload address used to download, digest and content-type checks, bytes left behind by a failed upload, an upload recorded into a bucket deleted while it arrived, public serving of private buckets, paused environments and deleted objects, both quota rules, the size and content-type policies, immediate removal of replaced versions, cleanup keeping bytes, not returning quota, skipping abandoned uploads and purging retained versions, bucket deletion and its confirmation, the bucket revision check, egress metering and attachment serving. The other four change nothing observable because a second guard holds: an oversized body is also caught by the digest, a replayed upload command by a unique constraint, an upload into a deleted bucket by the expired address and the completion check, and a wrong grant in Cloud's authority by Database's own verifier.

The affected regression passed **681 tests, 0 failures and 6,841 assertions across 84 files, with the three object-store tests run against a local MinIO container**. Generated contracts are
current and the TypeScript checks pass.

New gaps are G-76 to G-87. The largest: app users have no blob access (G-76),
objects are buffered in memory up to 256 MiB (G-77), and transfers are mediated
by Database rather than presigned (G-78).

Phase 11 stops here. Phase 12 (vector, graph and realtime parity) is next in
[the handoff](left-off/handoff.md).
