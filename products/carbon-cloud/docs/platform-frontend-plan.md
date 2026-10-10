# Carbon Cloud: Unified Platform Frontend Plan

Status: proposed functional specification for a future React + TypeScript implementation.
Prepared: 2026-09-06.
Deliverable for this task: this plan only. No frontend or backend implementation is included.

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Product model and ownership](#2-product-model-and-ownership)
3. [Repository baseline and known gaps](#3-repository-baseline-and-known-gaps)
4. [Actors, permissions and access rules](#4-actors-permissions-and-access-rules)
5. [Information architecture and route map](#5-information-architecture-and-route-map)
6. [Universal page and interaction contract](#6-universal-page-and-interaction-contract)
7. [Carbon account, organizations and onboarding](#7-carbon-account-organizations-and-onboarding)
8. [Cloud builds and Windows delivery](#8-cloud-builds-and-windows-delivery)
9. [Releases, update channels and signing](#9-releases-update-channels-and-signing)
10. [Database: relational and structured data](#10-database-relational-and-structured-data)
11. [Application authentication and user administration](#11-application-authentication-and-user-administration)
12. [Blob storage](#12-blob-storage)
13. [Vector and graph resources](#13-vector-and-graph-resources)
14. [Cloud functions and schedules](#14-cloud-functions-and-schedules)
15. [Realtime, migrations and backups](#15-realtime-migrations-and-backups)
16. [Registry, publishers and project plugins](#16-registry-publishers-and-project-plugins)
17. [Credentials, client integration, billing and activity](#17-credentials-client-integration-billing-and-activity)
18. [Platform operator workflows](#18-platform-operator-workflows)
19. [React architecture and adapter contracts](#19-react-architecture-and-adapter-contracts)
20. [Stateful mock system](#20-stateful-mock-system)
21. [Domain records and state machines](#21-domain-records-and-state-machines)
22. [Backend handoff and implementation sequence](#22-backend-handoff-and-implementation-sequence)
23. [Evidence index](#23-evidence-index)

## 1. Purpose and Scope

Build one application where developers register with Carbon, manage their organizations and projects, build Windows desktop applications, publish updates, manage application users and data, deploy functions, and consume or publish plugins.

The frontend belongs to `products/carbon-cloud/presentation/`. Cloud, Database, and Registry remain independently deployable backends. The unified frontend gives them one account experience and one navigation model. It does not require a new service or product directory.

The first frontend implementation must run entirely through mock adapters. All platform operations, credentials, emails, payments, repository connections, builds, uploads, function invocations, downloads, and subscriptions are simulated locally. Serving the frontend's own assets is allowed; connecting to existing local or remote Carbon APIs is not part of that implementation.

The primary deliverable will be functional structure: complete navigation, working forms, stateful workflows, permission-aware actions, clear contracts, and replaceable adapters. Visual design is secondary.

### 1.1 In scope

- Carbon account registration, authentication, recovery, sessions, and profile.
- Organizations, memberships, invitations, permissions, projects, and environments.
- Windows cloud builds, repository connections, build configuration, logs, artifacts, and workers.
- Windows releases, signing metadata, update channels, rollout, and release withdrawal.
- Application authentication and users, relational/JSON data, blobs, vectors, graphs, realtime, migrations, and backups.
- Cloud functions: development, deployment, invocation, schedules, execution history, and secrets within the existing products.
- Registry discovery, publisher identity, package versions, permissions, project dependencies, and trust administration.
- Shared billing, quotas, credentials, activity history, operational controls, and client integration guidance.
- A small operator area for Carbon staff, distinct from customer organization administration.
- Frontend/backend ownership, interface contracts, mock behavior, implementation sequencing, and functional completion criteria.

### 1.2 Explicit boundaries

- No rendering-engine, runtime, native windowing, or desktop performance changes.
- Windows x64 is the initial desktop build target. NSIS is the default installer; MSI/WiX is an additional Windows format. No macOS or Linux desktop release work.
- The operating system of backend hosting is independent of the desktop artifact target.
- No new standalone compute, identity, email, observability, billing, or other service. Functions and email-provider adapters extend existing products.
- No dedicated testing or E2E workstream in this plan. Completion is described through functional walkthroughs and contract completeness.
- No design system, marketing-site redesign, visual brand work, or GUI designer.
- No promise of a complete Supabase-compatible protocol or a general SQL engine inside the browser.
- No runtime updater modifications. Where cloud behavior needs client support that does not exist, show the capability limit and retain it as a later dependency.

### 1.3 How to read this document

Everything described as a requirement below is a target for the mock application and a contract for later backend work. It is not a claim that today's backend implements it.

The current-state inventory in section 3 is grounded in repository inspection. Proposed names, operations, routes, roles, and workflows elsewhere are design decisions. Backend endpoints will be finalized when their adapters are implemented.

## 2. Product Model and Ownership

### 2.1 One platform, three existing backend owners

| Owner | Responsibilities | Frontend area |
|---|---|---|
| Carbon Cloud | Carbon accounts, organizations, membership, project catalog, environments, billing, build orchestration, release/channel management, platform audit and operator controls | Account, organization, project shell, Builds, Releases, Settings, Billing, Operations |
| Carbon Database | Project/environment data resources, application-user administration surface, storage, policies, vectors, graph, realtime, migrations, backups, function execution resources | Database, Storage, Authentication, Realtime, Functions |
| Carbon Registry | Publisher namespaces, packages, immutable versions, distribution, trust metadata, package review and withdrawal | Registry, Publishing, project Plugins, operator Registry review |
| Existing distribution capabilities | Manifest production, signing, publication, rollout and withdrawal contracts used by Cloud | Releases and signing settings |
| Existing plugin lifecycle capabilities | Local resolution, installation, declarations, capability grants and Windows build integration | Project Plugins and CLI integration instructions |

Cloud owns the canonical organization/project/environment IDs. Database stores resource bindings to those IDs; it does not independently create a second project identity. Registry packages are organization-owned and can be dependencies of many projects.

Application auth already lives in `solutions/capabilities/cloud/auth` and is composed into Cloud. Keep that as the initial authentication authority. Database's Authentication pages administer the same application identities through an adapter, and Database enforces their access to data. Presenting auth beside data does not require a duplicate account store or an immediate service move.

Functions get one frontend entry under a project/environment. Initially the service adapter can map to the existing Database function engine. Later execution isolation and scheduling can be implemented within the existing Cloud/Database deployment structure. Users should not see two competing function systems.

### 2.2 Canonical resource hierarchy

```text
Carbon account
  -> organization memberships
     -> organization
        -> projects
           -> repository and build configuration
           -> environments: development, staging, production
              -> database resources and blobs
              -> application auth realm and users
              -> function deployments and schedules
              -> environment credentials and secret references
           -> builds and immutable build artifacts
           -> application releases and update channels
           -> plugin dependency declarations and resolved revisions
        -> publisher namespace and published plugin packages
        -> billing, quotas, members, audit history

Carbon operator identity
  -> separately authorized platform operations
```

An environment isolates data, app-user sessions, secrets, and function deployments. An update channel selects which desktop release is offered to installations. These are different concepts: the `beta` channel may distribute an app configured for production data. Every release records its environment explicitly; choosing a channel never silently switches its data environment.

One project represents one application for the first implementation. Monorepo support means selecting a repository subdirectory for that application. Multiple applications use separate projects, even when they share one repository.

### 2.3 Sources of truth

| Concern | Authority | Synchronization rule |
|---|---|---|
| Org/project/environment identity | Cloud catalog | All service records reference canonical IDs |
| Repo source, dependency declaration, app manifest | Selected immutable commit | Dashboard edits generate a change proposal; they do not silently overwrite source |
| Cloud-only settings | Versioned Cloud configuration | Build snapshots record the exact revision used |
| Secret values | Backend secret storage; mock store during mock work | Responses expose metadata and references; never expose stored plaintext |
| Build result and artifact digests | Worker completion accepted by Cloud | Accepted immutable results cannot be edited from a form |
| Release and channel pointers | Cloud release management | Releases immutable after publication; pointers change through audited commands |
| Tables, blobs, graph, vector, function resources | Database | Cloud catalog holds references and provisioning status |
| App-user identities and sessions | Shared auth capability, realm-scoped | Admin UI and data access use the same identity contract |
| Plugin package bytes and version provenance | Registry | Consumer dependency locks pin version, target, and digest |

## 3. Repository Baseline and Known Gaps

Do not reproduce current backend omissions as intended product behavior in mocks.

| Area | Observed implementation | Gap the plan models |
|---|---|---|
| Cloud account surface | Organization-name signup creates an org bearer token; browser stores it in localStorage | Human accounts, membership, verified sign-in, account recovery, scoped credentials |
| Shared identity | Database and Registry call Cloud `/v1/auth/verify` | Consistent token audiences, organization/project access and role enforcement |
| Application auth | Magic-link request/consume/session verify, org-scoped end users | Realm/project/environment scoping, email delivery, logout, revocation, provider configuration |
| Cloud projects | Builds carry `orgId`, repository and commit | Canonical projects, environments, configuration revisions, project-bound builds |
| Builds | Queue, claim, run, fail/succeed, artifact upload | Cancellation, attempt records, leases, timeout/recovery, durable logs and managed worker allocation |
| Logs/artifact browser API | `BuildArtifactStore` holds process-local maps, while build records also contain artifacts | One durable query model and worker progress feed |
| Releases | Distribution signing/publish/rollback/yank capabilities exist | Project-scoped Cloud management pages and service endpoints; scoped object keys |
| Database | Postgres catalog, project schemas, SQL, vector/graph and S3-backed storage | Consistent tenancy checks and resource lifecycle; centralized project provisioning |
| Policy enforcement | Canned in-process RLS rules; unknown expressions return true | Fail-closed supported rules; authenticated end-user context; row checks for old and new values |
| Raw SQL | `SET LOCAL search_path` then `sql.unsafe` | Restricted database permissions: search path is name resolution, not tenant isolation |
| Blobs | Public/private flag stored; public route reads bytes without consulting it | Private access enforcement, signed URLs, binary transfers, lifecycle and quotas |
| Realtime | In-process subscriptions, application mutation broadcasts, unrestricted topics | Authenticated subscriptions, project/row authorization, reconnect contract; no implied WAL coverage |
| Functions | Postgres code/env storage; `AsyncFunction` runs within service process | Isolated execution, limits, immutable deployments, secret references and invocation authorization |
| Registry | Postgres/S3 publishing, org ownership check, archive signatures | Scoped publishing permissions, package validation, durable trust, real standard-plugin archives |
| Registry install | CLI verifies archive, writes archive and a small manifest | Extraction, DLL staging/signatures, dependency lock and app declarations |
| Registry bootstrap | Standard entries contain `dummy-tarball-content-for-*` | Actual versioned Windows packages or explicitly labeled mock fixtures |
| Registry trust | Ephemeral key fallback; client fetches signing key from same endpoint as archive | Persisted trust anchors, rotation, revocation, independent trust establishment |
| Desktop updater | Rust capability, TypeScript helpers and separate updater product coexist | Explicit supported client contract; frontend cannot assume all paths agree |
| Billing | Free/pro build-minute limits and Checkout integration | Full subscription lifecycle, invoices, resource usage, budgets and payment failure states |

The placeholder `downloadUpdate()` identified in earlier research is one TypeScript helper, not evidence that every updater path calls it. The standalone updater has another checker, and the runtime has a Rust path. Integration must map actual producers and consumers before claiming cloud rollback or update application works.

Specific source references are collected in section 23.

## 4. Actors, Permissions and Access Rules

### 4.1 Actors

| Actor | Main needs |
|---|---|
| Visitor | Register, sign in, browse public packages, accept an invitation |
| Carbon account holder | Profile, security, sessions, organizations, CLI authorization |
| Organization owner | Ownership, membership, projects, production policies, billing, organization deletion |
| Organization administrator | Team/project administration and production operations |
| Application frontend developer | Discover data contracts, configure app auth, inspect development data, invoke functions, integrate plugins |
| Application backend developer | Manage schemas, policies, storage, functions, migrations and project credentials |
| Release manager | Build, inspect artifacts, publish and manage update channels |
| Plugin publisher | Own a namespace, submit packages, inspect reviews, publish versions and deprecate releases |
| Billing manager | Subscription, invoices, budgets, billing contact and aggregate usage |
| Viewer | Authorized metadata, operational status, and non-sensitive summaries |
| Application end user | Sign in to a customer's app and use resources allowed by that app's policies |
| Carbon operator | Infrastructure jobs, worker fleet, provisioning failures, abuse and registry review |
| Automation principal | Narrow service account or token for CI, builds, publishing or scheduled execution |

Frontend/backend developer and release manager are working personas, not necessarily separate membership roles. The first role presets are Owner, Admin, Developer, Viewer, Billing. Specific grants add project/environment privileges where necessary.

### 4.2 Permission matrix

`Y` means included, `G` means an explicit scoped grant is required, `Self` means only the actor's own records, and `-` means unavailable. All project actions also require assignment to that project. Owners/admins have all projects by default.

| Action | Owner | Admin | Developer | Viewer | Billing |
|---|---|---|---|---|---|
| View permitted project metadata | Y | Y | Y | Y | Usage only |
| Edit organization settings | Y | Y | - | - | Billing fields |
| Invite members/change non-owner roles | Y | Y | - | - | - |
| Transfer ownership/delete organization | Y | - | - | - | - |
| Create/archive projects | Y | Y | G | - | - |
| Configure dev/staging resources | Y | Y | Y | - | - |
| Read development rows/blob contents/app users | Y | Y | G | G | - |
| Write development data | Y | Y | G | - | - |
| Read production customer data | Y | Y | G | G | - |
| Mutate production data/schema/auth | Y | Y | G | - | - |
| Trigger/cancel own development build | Y | Y | Y | - | - |
| Cancel another actor's build | Y | Y | G | - | - |
| Publish production release/change stable | Y | Y | G | - | - |
| Change trust or signing configuration | Y | G | - | - | - |
| Manage secret references/write secret values | Y | Y | G | - | - |
| Reveal a previously stored secret value | - | - | - | - | - |
| Publish/deprecate org plugins | Y | Y | G | - | - |
| Change billing/subscription | Y | - | - | - | Y |
| Read security audit | Y | Y | G | - | Billing events |
| Revoke own account sessions/tokens | Self | Self | Self | Self | Self |

Admin access to customer data is still audited. A future stricter organization can remove sensitive-data grants from administrative presets; resource management and customer-data access must remain distinct permissions in contracts.

### 4.3 Rules enforced by every adapter

1. Resolve the active principal from adapter session state. Do not trust a form field to declare its actor or role.
2. Verify organization membership and resource ownership for every query, mutation, download and subscription.
3. Derive role/audience/environment from trusted state. A worker token cannot act as a dashboard user or Registry publisher.
4. Use a not-found response for inaccessible foreign resources where disclosing existence is inappropriate; use forbidden for a known resource with an unavailable action.
5. Prevent removing/demoting the last owner. Ownership transfer requires acceptance and fresh authentication.
6. Removing membership revokes access immediately, including active subscriptions and cached sensitive results.
7. Organization roles do not turn a Carbon account into a customer's app user. App-user tokens cannot administer Cloud.
8. Production mutations require the corresponding explicit permission and the project's production policy. Confirmation is not authorization.
9. Operator roles are independent of customer memberships. There is no automatic customer impersonation.
10. Every material mutation creates an audit record with actor, scope, time, action, resource and result. Secret values and raw customer data are excluded.

## 5. Information Architecture and Route Map

Use stable IDs in routes. Names may change without breaking links. Scope is visible on every resource page. Deep links restore context from authorized route parameters, not a stale remembered organization.

Route aliases below:

- `O` = `/orgs/:orgId`
- `P` = `/orgs/:orgId/projects/:projectId`
- `E` = `/orgs/:orgId/projects/:projectId/environments/:environmentId`

### 5.1 Public and account routes

| Route | Page and primary actions |
|---|---|
| `/` | Resolve session; redirect to organizations or sign-in |
| `/sign-up` | Create a Carbon account, accept required terms, request verification |
| `/sign-in` | Email sign-in or configured provider; retain safe return destination |
| `/auth/callback` | Complete identity challenge/provider callback |
| `/auth/recovery` | Recover account access using configured recovery method |
| `/invites/:token` | Preview minimal invitation context, authenticate, accept/decline |
| `/authorize-cli` | Review device/CLI authorization and requested scopes |
| `/account/profile` | Name, avatar, email and account lifecycle |
| `/account/security` | Sign-in methods, MFA, recovery and linked identities |
| `/account/sessions` | Current/other sessions, last activity and revoke |
| `/account/tokens` | Personal automation credentials and device grants |
| `/account/notifications` | Notification inbox, unread state, preferences and resource links |
| `/organizations` | Organizations, pending invitations, create organization |
| `/registry` | Public package discovery, search and filters |
| `/registry/:packageId` | Public package details, versions, compatibility and install entry |
| `/app-auth/:realmId/sign-in` | Mock hosted application sign-in; separate from Carbon account |
| `/app-auth/:realmId/callback` | Complete mock application sign-in and safe redirect |

The mock app-auth routes exist to demonstrate application-user workflows. They do not authenticate a dashboard session.

### 5.2 Organization routes

| Route | Page and primary actions |
|---|---|
| `O/overview` | Project/status summary, recent activity and actionable failures |
| `O/projects` | Search/list/create projects, view provisioning/archived states |
| `O/members` | Members, project assignments, invites, roles and removal |
| `O/settings` | Organization name, namespace, ownership, deletion |
| `O/security` | Organization access policy, MFA requirements, credential inventory |
| `O/credentials` | Organization service accounts, scoped automation tokens, expiry and revocation |
| `O/connections` | Repository installations, provider scopes and reconnect/disconnect |
| `O/billing` | Plan, subscription state, payment method, invoices and billing details |
| `O/usage` | Resource usage, budgets, limits, historical periods and per-project breakdown |
| `O/activity` | Filtered audit and operational events |
| `O/publishing` | Owned packages and pending submissions |
| `O/publishing/:packageId` | Package settings, releases, ownership and review history |
| `O/publishing/:packageId/versions/:versionId` | Version assets, provenance, trust, review and withdrawal |
| `O/workers` | Customer-managed Windows workers and their organization-scoped credentials |

### 5.3 Project routes

| Route | Page and primary actions |
|---|---|
| `P/overview` | Setup tasks, environment health, build/release summaries |
| `P/settings/general` | Project metadata, stable IDs, archive/delete |
| `P/settings/access` | Assignments and production action grants |
| `P/settings/environments` | Create/configure/pause environments and provisioning state |
| `P/settings/repository` | Repository, branch, subdirectory, triggers and configuration proposals |
| `P/settings/build` | Windows installer format, build profile, cache and limits |
| `P/settings/signing` | Public key metadata, signing references, certificate status and rotation |
| `P/builds` | Filter builds, trigger/manual rebuild, inspect queue |
| `P/builds/:buildId` | Summary, steps, logs, inputs, plugin resolution and artifacts |
| `P/releases` | Draft and published releases; create from successful build |
| `P/releases/:releaseId` | Artifact/signature manifest, notes, rollout history and withdraw |
| `P/channels` | Stable/beta pointers and rollout settings |
| `P/channels/:channelId` | Publish/promote/pause/resume/rollback and delivery evidence |
| `P/plugins` | Desired dependencies, resolution status, grants and upgrades |
| `P/plugins/:dependencyId` | Pinned version, permissions, package trust and affected builds |
| `P/activity` | Project events with environment/resource filters |

Build lists may filter by environment. An individual build retains the environment/configuration it was created with, regardless of current UI selection.

### 5.4 Environment routes

| Route | Page and primary actions |
|---|---|
| `E/overview` | Provisioned resources, connection settings and environment readiness |
| `E/database/tables` | Schema/table catalog, create table, import data |
| `E/database/tables/:tableId` | Rows, columns, relationships, indexes, policies and settings |
| `E/database/sql` | Saved queries, constrained mock execution, results and history |
| `E/database/migrations` | Ordered migrations, plans, drift, apply and execution history |
| `E/database/backups` | Snapshot coverage, create, export, restore and retention |
| `E/database/vectors` | Collections, dimensions, indexes and usage |
| `E/database/vectors/:collectionId` | Points, metadata, vector query and scores |
| `E/database/graph` | Graph catalog/labels, nodes, edges and traversal |
| `E/storage` | Buckets, visibility, quota and access policy |
| `E/storage/:bucketId` | Object listing, upload, download, metadata, versions and deletion |
| `E/auth/users` | App users, search, invite/create, status and counts |
| `E/auth/users/:userId` | Profile/metadata, identities, sessions, events, ban/delete |
| `E/auth/providers` | Sign-in methods and provider configuration |
| `E/auth/settings` | Redirect allowlist, session lifetime, signup and email settings |
| `E/auth/events` | Authentication attempts, challenge delivery and failures |
| `E/functions` | Functions, active deployments and invocation summaries |
| `E/functions/:functionId` | Source versions, deployments, settings and invocation console |
| `E/functions/:functionId/invocations/:invocationId` | Status, logs, input/output summaries and resource usage |
| `E/functions/:functionId/schedules` | Schedule, timezone, next occurrence and delivery history |
| `E/realtime` | Publication configuration, allowed topics and connections |
| `E/realtime/inspector` | Authorized subscription, event stream and connection state |
| `E/settings/api` | URLs, project public identifier, scoped server credentials and client setup |
| `E/settings/secrets` | Secret metadata, create/replace/rotate/remove |
| `E/settings/limits` | Budgets, resource limits and environment restrictions |

`/graph` starts with functional node/edge tables and a query panel; a graphical canvas is optional. `?prefix=` selects blob folders; no arbitrary path is treated as an authorization scope.

### 5.5 Operator routes

| Route | Restricted responsibility |
|---|---|
| `/operations` | Service/queue summary, active failures and capacity |
| `/operations/organizations/:orgId` | Provisioning and entitlement metadata; suspension lifecycle |
| `/operations/jobs/:jobId` | Failed operation details, retry/cancel and repair history |
| `/operations/workers` | Managed Windows fleet, leases, capacity and drain |
| `/operations/registry` | Submission review, abuse reports and revocations |
| `/operations/trust` | Registry key metadata, rotation state and revocation history |
| `/operations/audit` | Operator activity and access records |

Operators cannot read arbitrary customer rows, blobs, source code or secrets by default. A future support-access workflow must be separately authorized, time-bounded and audited; it is not included as silent impersonation.

## 6. Universal Page and Interaction Contract

Every route above must have these behaviors when applicable:

- Initial loading, empty state with a relevant next action, populated state, filtered-no-results, recoverable error, forbidden/not-found, and unavailable capability.
- Persist filters, sort order, pagination and selected tab in the URL. Keep transient field edits local to the form.
- Paginate resource lists. Selection is explicitly either selected IDs on the current page or an adapter-generated snapshot of a larger selection.
- Detail pages have stable links, a resource revision, and scope breadcrumbs. Names are escaped and user content is treated as untrusted.
- Mutations show pending state and prevent duplicate submission. Completion follows confirmed adapter state.
- Long work returns an operation ID and opens a progress view. Closing that view does not cancel the operation.
- Destructive actions identify the exact resource, environment, dependent resources and retention effect. Bulk actions report per-item outcomes.
- Dirty editors intercept scope/navigation changes and offer discard or keep draft. Drafts are keyed by account/org/project/environment/resource.
- Production edits identify the production target before confirmation. A confirmation never bypasses permission checks.
- Concurrent changes produce a revision conflict with reload/compare choices; do not silently overwrite another edit.
- Authentication expiry preserves a non-secret draft, asks the user to reauthenticate, and does not automatically replay a destructive mutation.
- A failed request with uncertain outcome can be recovered using its operation/idempotency ID.
- Data from a prior org/environment must be removed before rendering a new scope. Abort pending reads and unsubscribe from its streams.
- Show unavailable metrics as unknown or not reported. An empty response is not proof of zero incidents or successful delivery.
- Downloads are explicit commands through an adapter. Mock downloads contain local fixture data and cannot launch an installer or execute code.
- Every button has an implemented outcome, validation feedback, or an explicit capability restriction. No decorative controls that pretend an action occurred.

## 7. Carbon Account, Organizations and Onboarding

### 7.1 Authentication decisions

Start with email magic-link registration/sign-in for Carbon accounts. Model a GitHub provider as a configured option; provider operations remain mock. Account MFA, recovery codes and session management are part of the target functionality. Password sign-in is not required for Carbon account v1; do not create a reset-password page for an account that has no password.

Application auth can have different enabled methods, configured per realm. That distinction must be visible in adapter contracts.

The mock challenge inbox and account switcher belong to development-only mock tooling. A future real sign-in response never returns a usable challenge token in a generic public response.

### 7.2 Account stories

| ID | Story and workflow | Outcome, exceptions and future backend obligation |
|---|---|---|
| ID-01 | Visitor enters name/email, accepts required terms, requests sign-up; follows mock verification link | Pending verification becomes active account. Duplicate account follows sign-in without revealing private account details. Record terms version and verification |
| ID-02 | Account holder requests sign-in, completes challenge/provider response and optional MFA | Establish a session, then return to the authorized destination. Expired/reused/invalid challenge yields retry, not a session |
| ID-03 | User follows an invitation while signed out | Preserve invitation through authentication; require matching verified email; accept once, then open organization |
| ID-04 | User updates name/avatar or changes email | Name saves immediately; email change requires confirmation before replacing verified address. Reject conflicting identity link |
| ID-05 | User enrolls MFA and receives recovery codes | Require successful enrollment verification; recovery codes shown once; reset revokes previous codes |
| ID-06 | User loses a sign-in method | Use verified alternative/recovery code; unresolved recovery becomes a pending support case, never automatic account takeover |
| ID-07 | User lists sessions and revokes one or all others | Revoked session loses subscriptions and access; current session is clearly identified |
| ID-08 | User links/unlinks provider identity | Prevent removing final usable sign-in method; linking requires proof of both identities |
| ID-09 | User signs out or requests account deletion | Clear session and sensitive caches. Deletion blocked by sole ownership until transfer/organization deletion is resolved |
| ID-10 | Developer authorizes a CLI device request | Review client, code, organization and scopes; approve/deny; issue scoped grant once. Expiry, reuse and wrong code are explicit |
| ID-11 | Developer creates/revokes a personal token | Choose name, expiry and permitted scopes no broader than actor; show secret once; retain prefix/last-use only |

The mock session is a fake local identity. Future HTTP integration should use secure server-managed browser sessions and CSRF protection for cookie-authenticated mutations. Do not preserve the existing browser pattern of storing an organization administration token as the normal dashboard login.

### 7.3 Organization stories

| ID | Story and workflow | Outcome and refusal conditions |
|---|---|---|
| ORG-01 | Account creates organization with name and available namespace | Creator becomes Owner; default entitlement assigned; organization appears in switcher |
| ORG-02 | Member switches organizations | Re-evaluate permissions, close old subscriptions and restore an authorized destination; never reuse old selected project blindly |
| ORG-03 | Owner/Admin invites verified email or pending account with role/project assignments | Invitation pending until accepted; resend rotates challenge; expiry, cancellation and already-member handled |
| ORG-04 | Admin updates role/project grants | New permissions apply immediately. Actor cannot grant capabilities they cannot delegate |
| ORG-05 | Owner/Admin removes member; member leaves | Remove org access and org-scoped personal grants; service-account ownership policy is explicit; last owner cannot leave |
| ORG-06 | Owner transfers ownership | Select active member, fresh authentication, recipient accepts; prior owner gets chosen lesser role |
| ORG-07 | Billing manager updates billing contact | Separate from identity email and membership; does not gain project-data access |
| ORG-08 | Owner requests organization deletion | Inventory projects, retained releases, packages, invoices and active jobs; confirm; return tracked deletion operation with blockers |

Do not cascade public package disappearance or invoice deletion from an organization-delete button. Published artifacts may have retention and consumer obligations. Present retained/tombstoned resources with the reason.

### 7.4 Project onboarding stories

| ID | Story and workflow | Outcome and edge cases |
|---|---|---|
| PROJ-01 | Developer creates project, chooses slug, default environment and optional repository | Canonical project ID allocated once; provisioning operation creates service bindings; no duplicate projects on retry |
| PROJ-02 | Developer starts with data only or builds only | Irrelevant setup remains optional; enabling another resource later uses the same project identity |
| PROJ-03 | Developer enables Database/Auth/Functions for an environment | Show independent provisioning stages and failure recovery; project can be partially available |
| PROJ-04 | Developer connects repository and chooses branch/subdirectory | Validate access and locate app manifest; show configuration conflict/missing manifest as fixable setup state |
| PROJ-05 | Developer creates staging/production | Create isolated resources; offer copying schema/configuration, never production data or secret values by default |
| PROJ-06 | Member views project setup | Checklist is computed from resource state: identity, repository, first build, API access, first table, release as relevant |
| PROJ-07 | Admin archives or pauses project/environment | Stop new mutations/deployments according to documented state; retain existing published update availability unless explicitly withdrawn |
| PROJ-08 | Owner deletes project/environment | Dependency preview, active-job handling, backup/export option and asynchronous deletion; preserve audit/tombstone records |

Environment deletion must block while a published release depends on that environment unless an explicit reviewed migration/retirement procedure has resolved the dependency.

## 8. Cloud Builds and Windows Delivery

### 8.1 Build pages and records

The build list shows build ID, project/environment, commit, trigger, author, target format, status, queued time, running duration and outcome. Filters include status, branch, actor, target, date and environment.

Build detail tabs: Summary, Steps, Logs, Inputs, Artifacts, Plugins. Inputs include immutable commit, root directory, app manifest digest, toolchain version, build configuration revision, environment binding and secret version references. Secret plaintext never appears.

Use `nsis` and `wix` as installer format identifiers, matching current contracts. Store the canonical Windows target triple separately from installer format. Do not mix `win32`, `windows-x86_64` and target triples without an explicit transport mapping.

### 8.2 Build workflow

1. User selects project/environment, repository ref and Windows installer formats.
2. Resolve ref to immutable commit and inspect configuration/dependency lock.
3. Show preflight: repository access, project permissions, worker capacity, quota, configuration, signing readiness and compatible plugins.
4. User submits once; adapter returns queued build and operation identity.
5. Worker lease is assigned; stages progress through fetch, dependency resolution, bundle, package, sign, upload and finalize.
6. Stage logs stream with sequence numbers. Stage duration is separate from queue duration.
7. Completed build exposes immutable artifacts with sizes, digests, signature states and retention.
8. User downloads a fixture artifact or starts a draft release. Build success alone does not publish updates.

### 8.3 Build stories

| ID | Actor and action | Required behavior |
|---|---|---|
| BUILD-01 | Developer triggers manual Windows build | Preflight rejects missing repository/manifest, forbidden environment, revoked plugin or quota; successful submission opens detail |
| BUILD-02 | Developer configures push-triggered build | Select branch and events; simulate provider event; duplicate delivery yields one build; record trigger identity |
| BUILD-03 | Developer changes repository connection | Warn about dependent projects, missing permissions and stale branch refs; reconnect does not discard build history |
| BUILD-04 | Developer edits build settings | Version configuration; show repo-defined versus Cloud overrides; conflicting app names/versions require resolution |
| BUILD-05 | User searches/follows logs | Filter stage/stream, pause auto-follow, download redacted text and reconnect from last cursor |
| BUILD-06 | User cancels queued/running build | Queued cancel terminal immediately; running becomes cancel-requested until worker acknowledges; race with completion uses authoritative state |
| BUILD-07 | User retries failure | New build/attempt with link to original; default same immutable inputs; using latest commit is an explicit separate action |
| BUILD-08 | Worker expires during build | Lease expires, retry policy creates bounded replacement attempt or fails; stale worker cannot finalize a newer attempt |
| BUILD-09 | User downloads artifact | Check project permission and retention; get local fixture blob now, authorized short-lived URL later |
| BUILD-10 | Release manager reviews signing | Distinguish not configured, signed, invalid, expired and unknown; unsigned build may exist but production publication is blocked by policy |
| BUILD-11 | Admin invalidates build cache | Scoped request for next build; existing artifacts and provenance unchanged |
| BUILD-12 | User deletes expired/unneeded build artifacts | Retention policy and release references block removal; logs/metadata retained according to policy |

### 8.4 Windows workers

Customer-managed workers remain org-scoped, matching the current token model. Carbon-managed workers are platform resources: customers see capacity/queue information, while operators allocate workers through task-scoped leases. Do not give a managed worker an unrestricted organization administration token to cross tenants.

Worker pages show ID, registration state, supported Windows formats/toolchains, last heartbeat, running task, capacity and drain status. Register returns a one-time fake enrollment credential. Rotate/revoke credentials, pause accepting new tasks, drain existing work and remove an offline worker are distinct actions.

The real backend must isolate execution of customer repositories, provide task-scoped access to source/artifacts/secrets, impose time/resource limits, redact logs and clean workspaces. The mock models these stages and failure states; it executes no builds or user code.

## 9. Releases, Update Channels and Signing

### 9.1 Vocabulary

- Build artifact: immutable output of a build, possibly an installer, bundle or update payload.
- Release: a versioned application record tying approved artifacts to notes, signatures, source and environment.
- Channel: a mutable pointer to a release with rollout policy, such as stable or beta.
- Rollout: which installations may discover a release, using a stable installation cohort.
- Withdrawal/yank: prevents an unsafe version from being offered according to the supported updater contract.
- Channel rollback: repointing future discovery to a previous compatible release. It does not prove installed clients downgrade.

An NSIS/MSI installer is not automatically a valid incremental/update payload. The release adapter must expose payload kind and client compatibility, and refuse unsupported combinations.

### 9.2 Release workflow

1. Release manager chooses a successful immutable Windows build and version.
2. Creates draft with notes, environment, source artifact selection, required client compatibility and channel target.
3. Preflight checks signatures, project ownership, artifact retention, version uniqueness, app manifest version, dependency trust and migration compatibility.
4. Publishing creates immutable release metadata and signed manifest assets, then updates channel state through a version-checked operation.
5. UI displays published pointer and rollout separately from delivery observations.
6. Widen rollout, pause future discovery, promote to another channel or withdraw through separate audited actions.

### 9.3 Release stories

| ID | Story | Expected result and exceptional state |
|---|---|---|
| REL-01 | Create/edit draft from build | Edits allowed until publish; changing version inconsistent with binary metadata requires rebuild or supported packaging revision |
| REL-02 | Publish release | Long operation: validate, sign, upload, commit pointer. Failure before pointer commit leaves previous channel usable; retry idempotent |
| REL-03 | Promote beta release to stable | Reuses artifact bytes; checks intended environment/compatibility; channel pointer changes independently |
| REL-04 | Set staged rollout | 0-100 integer percentage, stable cohort ID, preview estimated eligible installations; unknown population stays unknown |
| REL-05 | Pause/resume rollout | Stops new offers if client protocol supports it; no recall of already downloaded or running software |
| REL-06 | Roll back channel | Select previous signed release, view compatibility and data migration constraints; clear distinction between pointer change and client downgrade |
| REL-07 | Yank compromised version | Require reason and replacement plan; version remains in history; publish withdrawal metadata only using client-supported format |
| REL-08 | Inspect installation/update evidence | Show last reported observations and timestamp; simulated/offline/stale status; no invented delivery counts |
| REL-09 | Rotate application update key | Create key metadata, publish supported cross-signing transition, retain overlap window, show client compatibility blockers |
| REL-10 | Configure Windows certificate | Store backend secret reference, public certificate identity/expiry and verification status; private material never returned in detail DTO |
| REL-11 | Delete release draft or expire assets | Draft can be removed; published/channel-referenced artifacts are retained or explicitly withdrawn with dependency review |

### 9.4 Compatibility limit for this project

Cloud push updates means publishing signed update availability to installed applications. The existing ecosystem primarily uses discovery/polling. The dashboard does not get an ability to remotely execute or restart customer PCs.

Fleet telemetry, forced update application, delivery acknowledgements and downgrade behavior are mocked with capability metadata. They cannot be advertised as live until existing client integrations support them. Runtime changes remain out of scope.

## 10. Database: Relational and Structured Data

### 10.1 Data scope and access modes

Offer two explicit views of data:

- Administrative view: requires database administration/data-read permission for the environment and is audited.
- Policy preview: evaluates a selected mock app-user/anonymous identity with the same intended policies used by client access. This is a simulation, not impersonation or issuance of a user's real token.

Never let a table-editor switch change real authorization silently. A Viewer can inspect schema metadata without automatically receiving customer rows.

Initial table types: text, integer, decimal, boolean, timestamp, UUID, JSON/JSONB and supported arrays. Handle SQL NULL, empty string and missing input distinctly. JSON is the initial document-data solution; a separate document database or cache product is not assumed.

### 10.2 Table stories

| ID | Workflow | Required behavior |
|---|---|---|
| DATA-01 | Create table with columns/types/defaults, primary key and RLS policy | Validate identifiers, duplicates, nullability and supported defaults; present resulting schema change |
| DATA-02 | Browse rows, filter, sort, paginate, choose columns | Adapter performs scoped query; filters encoded structurally; empty result distinct from inaccessible data |
| DATA-03 | Insert row through typed fields/JSON editor | Apply defaults; validate types/required fields/foreign keys; policy check proposed row; show saved canonical values |
| DATA-04 | Edit row or selected cells | Use row identity and revision; concurrent edit produces conflict; update policy checks existing and proposed values |
| DATA-05 | Delete selected rows | Preview exact selection/count and constraints; apply transaction or return explicit per-item results |
| DATA-06 | Import CSV/JSON | Upload local fixture, map columns, preview errors, choose conflict mode; track operation and partial/atomic outcome |
| DATA-07 | Export selected or filtered rows | Permission plus snapshot of selected query; background operation for large sets; generated local download in mock |
| DATA-08 | Add/rename/change/drop column | Dependency preview for indexes/policies/functions; type conversion or destructive change can require migration |
| DATA-09 | Add/edit foreign key, unique/check constraint or index | Validate target schema, duplicates and supported expressions; index creation has tracked progress |
| DATA-10 | Rename/drop table or truncate rows | Distinct operations and permissions; show affected resources and retained backups; no accidental cascading default |
| DATA-11 | Read/write JSON document values | Structured validation and path filtering when supported; preserve numeric/boolean/null types |
| DATA-12 | Inspect generated data API/types | Use selected schema revision and environment; invalidate generated examples when schema changes |

The mock schema catalog and its rows share one state. Adding a column affects editor forms, type previews and subsequent query results. Tables without a stable row key can be read, but editing is unavailable until supported identity is defined.

### 10.3 SQL editor stories

| ID | Workflow | Contract |
|---|---|---|
| SQL-01 | Save/open/rename/share a query | Queries scoped to account or project; query text access separate from execution privilege |
| SQL-02 | Run read query | Select environment and execution role; results include columns, typed values, count, timing and truncation |
| SQL-03 | Run mutation/DDL | Explicit permission and production confirmation; show execution summary and refresh affected schema/rows |
| SQL-04 | Cancel running query | Cancellation requested, then acknowledged or too late; no promise of rollback once committed |
| SQL-05 | View history/download results | History redacts sensitive literals according to policy; result access rechecked |
| SQL-06 | Inspect query plan | Backend explain capability; mock returns scenario-specific plan, never claims a real cost measurement |

For mocks, execute a documented bounded set of fixture queries, with a parser or exact normalized fixture matching. Unknown SQL returns `unsupported_operation`. Never return invented success for arbitrary SQL and never implement a general SQL interpreter for this frontend.

### 10.4 Policy stories

| ID | Workflow | Contract |
|---|---|---|
| POLICY-01 | Enable RLS and choose permitted operations/roles | Default deny for app clients without an applicable rule; backend administration remains separately permissioned |
| POLICY-02 | Create owner-only rule | Bind verified app-user ID to row owner field; validate field type and realm |
| POLICY-03 | Allow explicitly public reads | Anonymous read policy only; does not implicitly allow writes or administrative endpoints |
| POLICY-04 | Preview policies against user and sample row | Show allow/deny with matching rule; unknown expression fails validation rather than allowing access |
| POLICY-05 | Change/delete policy | Show dependency and access impact; new requests/subscriptions use new policy revision |

Future database enforcement must use restricted database roles/permissions and appropriately scoped row access. `search_path` alone cannot restrict raw SQL, and frontend checks cannot protect a data-plane service.

## 11. Application Authentication and User Administration

### 11.1 Realm model

Each project/environment has an auth realm. End-user uniqueness is `(realmId, normalizedIdentity)`, not simply `(orgId, email)`. One person using two customer apps is not automatically the same app identity. Cross-application identity sharing is deferred until explicitly designed.

An app session carries realm/project/environment, user ID, audience, issued/expiry time and revocation reference. It has no organization-administration permissions. Carbon account login and app-user login cannot replace one another in browser state.

### 11.2 App-user stories

| ID | Workflow | Result and backend obligation |
|---|---|---|
| AUTH-01 | Developer enables signup and email magic-link provider | Realm configuration version saved; verified redirect allowlist and delivery settings required |
| AUTH-02 | App user requests sign-in and consumes link | One-time atomic challenge consumption creates realm session; retries/expired link cannot create extra sessions |
| AUTH-03 | Developer configures OAuth provider | Set client ID, secret reference, allowed redirect/callback and linking policy; mock provider success/denial/error |
| AUTH-04 | Admin invites/creates app user | Invitation delivered in mock inbox; creation is pending/active as configured, never silently marks unverified email verified |
| AUTH-05 | Admin searches users and views detail | Email/ID/status/provider/date filters; sensitive fields require grants; detail shows metadata and session count |
| AUTH-06 | Admin changes user metadata | Separate user-editable profile metadata from server-controlled claims/roles; client cannot grant itself privileges |
| AUTH-07 | Admin suspends user or revokes sessions | Future requests and realtime access denied; row ownership/data remain until separate action |
| AUTH-08 | App user signs out or rotates session | Revoke current session, clear app-client state; refresh cannot resurrect revoked identity |
| AUTH-09 | Admin deletes user | Show data ownership/orphan policy and retention; deletion does not imply cascading all rows/blobs without policy |
| AUTH-10 | Developer inspects sign-in/delivery failures | Paginated event history, reason, provider, correlation ID; no plaintext challenges or tokens |
| AUTH-11 | Developer configures session TTL, signup policy and redirect URLs | Validate boundaries; existing-session invalidation is an explicit choice with effects shown |
| AUTH-12 | App user resets password if password auth is enabled | Simulated reset challenge; no password disclosure; independently versioned optional provider capability |
| AUTH-13 | Developer links app auth to row/blob/function access | Mock app session can access only resources allowed by policies; org credential is never embedded in client examples |
| AUTH-14 | Admin exports users | Permissioned operation, selected fields and audit; excludes passwords, token hashes and secret credentials |

Application auth email template editing includes subject/body, allowed variables, preview, fake delivery and failure history. This uses a provider adapter in the existing auth capability, not a new email service. Real delivery credentials belong only on the backend.

## 12. Blob Storage

### 12.1 Bucket and object model

Buckets have stable IDs, environment, name, visibility, allowed MIME types, size limits, access policy and optional retention/versioning settings. Object keys are opaque keys normalized by the backend contract; listing prefixes are not file-system directories.

Objects have ID/key, content type, byte size, digest/ETag, creation/modification time, owner identity when applicable and version information when enabled. Existing S3 prefix storage can implement these logical buckets without introducing a new storage service.

### 12.2 Storage stories

| ID | Workflow | Expected behavior |
|---|---|---|
| BLOB-01 | Create private/public bucket | Private default; public visibility requires explicit confirmation; policy and limits visible |
| BLOB-02 | Browse/search prefixes and object metadata | Paginated listing; encoded names; no cross-project escape through key/path input |
| BLOB-03 | Upload one/many files | Per-file progress, cancel, conflict strategy and retry; binary file bytes supported, not only JSON text payloads |
| BLOB-04 | Preview/download object | Recheck authorization; safe preview for supported media/text, otherwise download; arbitrary HTML never executes in dashboard origin |
| BLOB-05 | Create expiring download/upload link | Choose TTL within policy; mock token validated against local scope/time; private object does not become permanently public |
| BLOB-06 | Rename/copy/move object | Operation reports copy plus deletion separately where storage lacks atomic rename; avoid deleting source on failed copy |
| BLOB-07 | Replace/delete object or delete bucket | Show versions/references/retention; nonempty bucket requires explicit recursive intent and operation results |
| BLOB-08 | Change bucket access | Public-to-private invalidates future public access subject to documented caching; previously downloaded copies cannot be recalled |
| BLOB-09 | View/restore object version | Available only when versioning capability enabled; restore creates a new current version |
| BLOB-10 | Configure per-user uploads | Bind app-user identity and permitted key prefix via policy; anonymous uploads disabled unless explicitly allowed |

The mock transfer adapter stores fixture bytes locally and validates limits. It simulates expired links, access denied, transfer cancellation, too-large file, conflicting object version and quota exhaustion.

## 13. Vector and Graph Resources

### 13.1 Vector stories

| ID | Workflow | Expected behavior |
|---|---|---|
| VEC-01 | Create collection with dimensions and supported distance metric | Persist fixed dimension; reject unsupported metric; changing dimensions requires new collection/migration |
| VEC-02 | Insert/upsert/import points and JSON metadata | Validate dimension, finite numbers, IDs and policy; report per-point errors |
| VEC-03 | Search by explicit vector with top-K and metadata filter | Return ordered IDs, scores with documented metric and metadata; bounds and score meaning explicit |
| VEC-04 | Edit/delete points or collection | Check permissions/dependencies; update usage and query results |
| VEC-05 | Configure/view index | Backend-supported index state, build progress and errors; mock status clearly simulated |
| VEC-06 | Inspect usage and connection recipe | Dimension/count/storage/last operation and supported API contract |

Embedding generation and an AI provider are not assumed. Users bring vectors. The mock uses deterministic small-vector calculations for supported metrics rather than external inference.

### 13.2 Graph stories

| ID | Workflow | Expected behavior |
|---|---|---|
| GRAPH-01 | Create/edit node with label and properties | Stable node ID; validate JSON and scoped uniqueness |
| GRAPH-02 | Create/edit edge with relationship and weight | Both endpoints must exist in same environment/graph; unsupported negative weights rejected for current shortest-path algorithm |
| GRAPH-03 | Browse/filter nodes, edges and neighbors | Pagination, label/property filters and links between detail records |
| GRAPH-04 | Find path between selected nodes | Show node sequence, edge sequence and total cost; no-path distinct from query failure |
| GRAPH-05 | Delete node/edge or import graph fixture | Explicit dependent-edge policy; preview unresolved endpoints and per-item failures |

Graph traversal must not reveal nodes or edges the requesting identity cannot access. A convenient visualization cannot weaken resource authorization.

## 14. Cloud Functions and Schedules

### 14.1 Function model

A function has identity, source revisions, configuration, secret references and permissions. A deployment is an immutable source/configuration snapshot assigned to an environment. An invocation belongs to one deployment and actor/trigger. A schedule invokes a function; it is not a second general-purpose job product.

Initially support HTTP invocation and schedule triggers. Database-event triggers may be added behind a capability after delivery/commit semantics are defined. External event buses, arbitrary workflow builders and global edge-region selection are deferred.

### 14.2 Function stories

| ID | Workflow | Result and exceptions |
|---|---|---|
| FN-01 | Developer creates function from fixture/template or repository path | Draft source and metadata; show supported request/response shape and execution limits |
| FN-02 | Developer edits source/configuration | Autosave draft explicitly distinguished from deployment; secret references validated; source never evaluated in browser |
| FN-03 | Developer deploys revision to development | Simulated package/validate/activate operation; prior deployment remains active on failure |
| FN-04 | Developer invokes with payload, headers and selected permitted identity | Mock fixture handler returns structured output/logs; request ID, deployment and duration attached |
| FN-05 | User inspects invocation history/logs | Filter status/time/trigger; bounded/redacted inputs and outputs; sensitive content requires separate permission |
| FN-06 | Release manager promotes deployment to production | Same source digest, target environment configuration and secret bindings reviewed; create target deployment record |
| FN-07 | Release manager rolls function back | Move active deployment pointer to compatible prior revision; does not undo side effects from previous invocations |
| FN-08 | Admin updates invocation authorization | Anonymous, app-session or service-credential policy; admin deployment access never implies public invocation |
| FN-09 | Admin disables/deletes function | Stop new invocations; handle existing invocations and schedules; retain history by policy |
| FN-10 | Developer adds schedule | Valid schedule/timezone, next-run preview, enabled state, missed-run policy and overlap policy |
| FN-11 | Developer retries failed invocation | New invocation with original reference; warn about previous side effects; idempotency key supported by function contract |
| FN-12 | Function accesses data/blob resources | Uses permitted invocation identity or declared service grant, scoped to environment; no inherited platform-admin credential |

### 14.3 Execution semantics

- Display timeout, memory, payload and concurrency limits supplied by the adapter; no invented paid plan promises.
- Invocations can queue, run, succeed, fail, time out or be cancelled. User exceptions differ from infrastructure failures.
- Retries may deliver more than once; the UI and backend contract do not promise exactly-once business effects.
- Schedule timezone and daylight-saving behavior are explicit. Show missed occurrence, skipped overlap and retry separately.
- Secret replacement affects new deployments/invocations according to binding policy; no silent rewriting of deployment history.
- Code editor source is data in mock mode. Use named fixture handlers, never `eval`, `new Function`, dynamic import of user code or arbitrary network fetch.
- The existing in-process `AsyncFunction` engine is not an isolation boundary for untrusted hosted code. The real adapter cannot be enabled until backend execution is isolated and constrained.

## 15. Realtime, Migrations and Backups

### 15.1 Realtime stories

| ID | Workflow | Behavior |
|---|---|---|
| RT-01 | Developer selects table/event types for realtime | Require table access; configuration records supported capture source |
| RT-02 | Developer opens inspector as an allowed app identity | Authorize project/topic/row policies before subscribing; show connection state |
| RT-03 | Another page changes data | After accepted commit, inspector receives deduplicated event with cursor, resource revision and timestamp |
| RT-04 | Connection drops or auth expires | Unsubscribe/reauthenticate; resume from cursor where supported, otherwise explicitly refetch and report a gap |
| RT-05 | Admin changes policy/revokes user | Subscription authorization re-evaluated; no continued stream of unauthorized rows |

The mock event bus shares transactions with mock row/function operations. Existing backend broadcasts cover application mutations, not every raw SQL write or an actual WAL feed. Show this coverage accurately until the backend changes.

### 15.2 Migration stories

| ID | Workflow | Behavior |
|---|---|---|
| MIG-01 | Developer registers migration revision | Ordered ID, name, checksum, forward SQL and optional reviewed reverse operation |
| MIG-02 | Developer previews/apply migration in development | Compare expected base schema and current revision; execute tracked operation; record outcome |
| MIG-03 | Developer detects dashboard/repository drift | Show differing schema/configuration; propose migration or reconciliation; no silent repair |
| MIG-04 | Admin promotes reviewed migrations to production | Validate applied ordering/checksums, dependencies, backup readiness and explicit permission |
| MIG-05 | User retries interrupted migration | Determine actual prior outcome before replay; changed checksum of applied migration rejected |
| MIG-06 | Admin requests rollback | Only if supported reviewed reverse exists; otherwise forward corrective migration or restore; never invent reversible SQL |

### 15.3 Backup stories

| ID | Workflow | Behavior |
|---|---|---|
| BACKUP-01 | Admin creates environment snapshot | Select supported coverage; snapshot operation records manifest, consistency boundary and per-resource results |
| BACKUP-02 | Admin schedules snapshot/retention | Configure timezone and retention within plan; no deletion of protected recovery points |
| BACKUP-03 | Authorized member downloads export | Short-lived access/fixture blob, audited; scope and included resources explicit |
| BACKUP-04 | Admin restores to new environment | Preferred default; provision target, preview compatibility, restore resources and report omissions |
| BACKUP-05 | Admin restores over existing environment | Strong confirmation, pause affected writes/jobs, explicit selected resources and conflict policy |
| BACKUP-06 | Partial restore fails | Show restored/skipped/failed resources and retry boundaries; never label entire restore complete on partial success |

A backup coverage manifest separately names relational rows/schema, policies, blob versions, vector points, graph, function source/config references and app-user metadata. Session tokens, platform credentials, signing private keys and secret values are excluded unless a future protected backend mechanism explicitly supports them. Restored app users must not revive old sessions.

Point-in-time recovery and transactionally consistent snapshots across Postgres/S3 are not current guarantees. They are unavailable capabilities in the initial model; a snapshot must expose its actual consistency limits.

## 16. Registry, Publishers and Project Plugins

### 16.1 Package model and identities

A package belongs to a publisher organization/namespace. A release version is immutable, has Windows artifacts, a manifest, declared capabilities, supported ABI/runtime compatibility, dependency metadata, content digests, provenance and trust status.

An account may publish only through an organization granting that permission. An app end user does not need a Carbon account merely to run a plugin already included in an installed application.

Keep local plugin slug distinct from registry identity. A future namespace such as `publisher/package` must map explicitly to the loader-compatible local name. Existing unscoped names must retain stable lookup/redirect behavior; do not assume current CLI parsing already supports namespaced/versioned syntax.

### 16.2 Discovery and publishing stories

| ID | Workflow | Result and exceptional states |
|---|---|---|
| PKG-01 | Visitor/member searches Registry | Name/category/capability/Windows support/license/trust filters; hidden/private packages absent without permission |
| PKG-02 | Developer inspects package version | README, license, changelog, author identity, manifest, requested permissions, compatibility, artifact digests and withdrawal history |
| PKG-03 | Publisher claims namespace/creates package | Require organization grant; namespace uniqueness, reserved-name policy and immutable package ID |
| PKG-04 | Publisher uploads Windows package version | Validate archive/manifest/artifacts; draft submission becomes validating/reviewing; upload alone does not imply public trusted release |
| PKG-05 | Publisher responds to review failure | Specific manifest/import/compatibility errors; replace unpublished submission revision; published bytes cannot change |
| PKG-06 | Publisher publishes approved version | Commit immutable signed package metadata and artifact references; version unique; latest/tag policy uses semantic versioning |
| PKG-07 | Publisher edits package README/metadata | Versioned metadata revision and permissions; provenance/signatures on old versions not rewritten |
| PKG-08 | Publisher deprecates version | Reason/replacement shown; resolution avoids it by default; already installed copies remain |
| PKG-09 | Authorized operator revokes malicious artifact | Digest-based revocation with reason/signed metadata; affected dependency/build views update; no claim of remote DLL removal |
| PKG-10 | Owner transfers package namespace ownership | Recipient acceptance, retained immutable author provenance, audit; no silent signing identity substitution |
| PKG-11 | Publisher makes package private/public | Enforce organization access on metadata/download; publication visibility change does not erase previously downloaded artifacts |
| PKG-12 | User reports package issue/abuse | Structured reason and version evidence routed to existing Registry administration queue |

### 16.3 Using a plugin in a project

1. Select authorized project and package version/range from Registry or project Plugins.
2. Resolve Windows-compatible versions and dependency closure against selected runtime/toolchain constraints.
3. Show exact resolution plan, digests, new/changed capabilities, conflicts and trust state.
4. Admin/developer approves capability changes they may grant; missing permission requests approval rather than escalating automatically.
5. Persist desired dependency revision and generate a repository change proposal or CLI handoff.
6. The mock simulates the proposal being accepted and the repository manifest/lock revision updating. The browser does not modify a real local repository.
7. A subsequent mock build resolves/stages the dependency and records its digest and grants in provenance.
8. Project page distinguishes desired, source-synchronized, built and released versions.

### 16.4 Project plugin stories

| ID | Workflow | Behavior |
|---|---|---|
| PLUGIN-01 | Developer adds dependency | Permission/trust/compatibility preflight; exact version/digest locked after resolution; no false 'installed locally' message |
| PLUGIN-02 | Developer updates dependency | Show changelog, transitives, ABI and permission differences; require renewed consent for capability expansion |
| PLUGIN-03 | Developer removes/disables plugin | Distinguish removal from disabling; source proposal and rebuild required; retained old releases unchanged |
| PLUGIN-04 | Developer opens integration recipe | Show current supported CLI flow, manifest changes and module exports from package metadata; proposed commands labeled until implemented |
| PLUGIN-05 | Build sees revoked/incompatible dependency | Block resolution/build according to policy and suggest allowed replacement; never silently choose a different package |
| PLUGIN-06 | Admin changes capability grant | Revision recorded; blocked if dependency requires denied capability; production changes reviewed separately |
| PLUGIN-07 | User views dependency impact | Trace package version to projects, builds and releases the org can access; no disclosure of other customers |
| PLUGIN-08 | Developer uses local/private plugin | Local development path distinct from registry publication; source/capability/developer-signature status explicit |

### 16.5 Trust and distribution requirements

- Separate authenticated publisher identity, archive integrity, binary signatures, import-policy checks, review status and revocation. One green 'verified' field cannot mean all of these.
- A native in-process DLL is not safely sandboxed merely because capability grants exist. Registry review/import policy/signing reduce risk but do not prove arbitrary native code harmless.
- Package archive validation must reject traversal, absolute paths, symlinks/reparse escape where relevant, decompression bombs, duplicate/case-colliding paths and wrong Windows artifact kinds.
- Signed metadata must bind package identity/version, Windows target, artifact digests and granted/declared capabilities as appropriate to the final protocol.
- Trust anchors must be persisted and established independently of a single download response. Key rotation has explicit old/new key state and revocation history.
- Registry archive signing and DLL load-time signing are distinct steps. The real lifecycle must stage the DLL and its loader-compatible detached signature, update `carbon/manifest.toml`, and manage capability grants in `carbon.toml`.
- Standard Windows plugins must use real packages in production. Mock fixtures are explicitly synthetic and never downloadable as purported working DLLs.
- Existing clients can only honor revocation they receive and support. Account/package suspension does not magically disable installed offline plugins; display propagation limits.
- No raw publisher signing private keys or Carbon signing secrets in the frontend. Operator pages manage metadata and approved backend operations.

## 17. Credentials, Client Integration, Billing and Activity

### 17.1 Credentials and secrets

| ID | Workflow | Behavior |
|---|---|---|
| SEC-01 | Create environment service credential | Name, expiry, audience and resource/action scope; actor cannot overgrant; fake secret shown once |
| SEC-02 | Rotate/revoke credential | Bounded optional overlap; last-used/prefix visible; dependent services flagged without revealing values |
| SEC-03 | Create/replace secret | Validate name/type and scope; only metadata returned; binding points shown |
| SEC-04 | Remove secret used by function/build/signing | Dependency preview and refusal until rebind/disable; no silent breakage |
| SEC-05 | View API setup | Public project/realm ID and endpoints separated from privileged service credentials; per-environment values |
| SEC-06 | Review own active integrations/devices | Revoke device/provider grant; affected projects shown; runtime app-user sessions remain distinct |
| SEC-07 | Admin creates/disables an organization service account | Assign narrow project/environment grants and issue separate expiring credentials; disabling revokes all of its credentials without depending on the creator's personal session |

Browser applications and distributable desktop apps are public clients. A packaged desktop binary cannot safely conceal an organization administrator key or general service credential. Client setup uses public project configuration plus app-user sessions; server-only examples identify secret references separately.

### 17.2 Developer integration workflows

| ID | Persona and goal | Dashboard journey |
|---|---|---|
| DEV-01 | Frontend developer adds app sign-in | Select environment, configure auth method/redirects, inspect mock hosted sign-in, copy supported setup contract |
| DEV-02 | Frontend developer loads user-owned data | Create table/owner policy with backend developer, use fake app identity, preview read/write denial cases |
| DEV-03 | Frontend developer uploads profile media | Private/public bucket choice, owner policy, upload constraints and expiry-aware URL contract |
| DEV-04 | Frontend developer consumes realtime/function | Configure authorized topic/function endpoint, inspect payloads/reconnect/errors and generated types |
| DEV-05 | Backend developer evolves schema | Draft migration, preview development changes, resolve drift and request production application |
| DEV-06 | Backend developer deploys function | Bind least-privilege data access/secrets, inspect invocations and promote reviewed deployment |
| DEV-07 | Developer connects local repo | Simulated CLI authorization, project/environment link, configuration proposal and dependency resolution |
| DEV-08 | Release manager ships desktop version | Successful Windows build -> signed release -> beta -> stable rollout, with retained provenance |

Setup pages may generate downloadable schema/types/configuration fixture files. They must derive from adapter data and supported contracts. Do not invent a working `@carbon/*` API that the repository does not export. Future SDK methods are clearly marked proposed in documentation data, then replaced when a backend/client contract is implemented.

### 17.3 Billing and quota stories

| ID | Workflow | Behavior |
|---|---|---|
| BILL-01 | Owner/Billing reviews usage | Period and project breakdown for builds/storage/functions/egress where supported; separate metered, estimated and unavailable values |
| BILL-02 | Change plan | Preview entitlement/pricing supplied by adapter, simulate checkout and pending confirmation; return URL alone does not upgrade plan |
| BILL-03 | Payment succeeds/fails/requires action | Subscription state and entitlements update only from simulated provider event; duplicate event idempotent |
| BILL-04 | Cancel/resume subscription | Show effective period end; no immediate data deletion or revoked downloads of retained releases |
| BILL-05 | Update payment method/details/download invoice | Mock provider workflow and local fixture invoice; no real financial transaction |
| BILL-06 | Set budget/alerts/hard cap | Validate plan limits; warning versus blocking behavior explicit per resource |
| BILL-07 | Resource exceeds quota | New charged work blocked with explanation; provide upgrade/reduce/retry; no silent destruction of existing data |
| BILL-08 | Downgrade below current usage | Preview conflicts and grace/block policy; require resolution or scheduled downgrade |

Current repository defaults are free/pro with 60/6000 included build minutes. Treat other quotas and prices as clearly fictional fixture values until commercial decisions exist. No specific price is recommended by this plan.

Meter running build time separately from queue wait. Record usage once per billable attempt/action with correlation and idempotency IDs; show refunds/adjustments as separate events. A cancelled build can still consume actual execution resources.

### 17.4 Activity and notifications

Every successful/failed material command links to an audit/operation record: who changed what, scope, timestamp, reason, status and safe metadata diff. Filter by member, project, environment, action and result. Downloads/exports of sensitive customer data are audited.

In-app notifications cover invitations, build completion/failure, release issues, quota alerts, provider reconnect, failed schedules and Registry reviews. Preferences decide in-app/email delivery; email is simulated. Notification read state is per account. Event history is not erased when a notification is dismissed.

Operational logs belong to the resource area and organization activity. This plan does not introduce an observability product.

## 18. Platform Operator Workflows

| ID | Actor and workflow | Required constraints |
|---|---|---|
| OPS-01 | Operator reviews provisioning failures and retries a step | Use persisted operation state; no duplicate org/project/resource creation; audit reason |
| OPS-02 | Operator registers/drains Windows managed worker | Task leases, heartbeat, capacity and drain acknowledgements; no exposure of customer secrets |
| OPS-03 | Operator cancels stuck job/requeues expired attempt | Reject stale worker completion; track replacement attempt and usage correction |
| OPS-04 | Registry reviewer approves/rejects submission | Review evidence and reason; approval distinct from cryptographic signature validity |
| OPS-05 | Security operator revokes artifact/rotates Registry key | Elevated permission/fresh authentication; approved metadata transition, impacted packages and audit |
| OPS-06 | Authorized operator suspends organization for abuse/billing policy | Specify which capabilities suspend and which read/recovery paths remain; record reason/effective time |
| OPS-07 | Operator investigates platform outage | Service binding/provisioning/log metadata; no default ability to browse customer databases |
| OPS-08 | Billing operator applies adjustment | Separate financial grant; immutable adjustment event rather than rewriting past usage |

The same React application may lazy-load `/operations` for operator sessions, but it uses a separate operator port and audience. Customer APIs cannot grant operator status. Mock scenario selection can switch to operator identity only through development tooling.

## 19. React Architecture and Adapter Contracts

### 19.1 Proposed placement

This is a target tree, not a request to scaffold empty folders. Create a folder when its first implementation lands. Migrate existing `presentation/src/*` into this structure as part of frontend implementation rather than maintaining two dashboards.

```text
products/carbon-cloud/
  docs/
    platform-frontend-plan.md
  composition/
    entrypoint.ts                  # existing server composition
    browser.tsx                    # React mount; browser-only imports
    create-browser-services.ts     # selects adapter implementations once
  presentation/
    index.html
    tsconfig.json                  # DOM/JSX browser compilation boundary
    App.tsx
    framework/
      routing/                     # route tree, context and guards
      session/                     # session provider and expiry handling
      services/                    # typed port interfaces + injection context
      queries/                     # query keys/cache lifecycle
      operations/                  # background operation presentation
      errors/                      # error mapping and recovery
    components/                    # shared functional controls
    features/
      account/
      organizations/
      projects/
      builds/
      releases/
      database/
      storage/
      auth/
      functions/
      realtime/
      plugins/
      publishing/
      billing/
      activity/
      operations/
    devtools/
      mock-scenarios/              # mock-only fixture/identity controls
  infrastructure/
    browser/
      mock/
        create-mock-services.ts
        store.ts
        clock.ts
        scenarios/
        adapters/
      http/                        # future; not wired in initial frontend
    http/                          # existing server routes
    persistence/                   # existing server persistence
```

Each feature owns its route pages, forms, presentation hooks and view-model mapping. Avoid a separate parallel `pages/Database` tree duplicating a `features/database` owner. `App.tsx` is the route/provider shell, not the entire application.

Frontend-specific ports can start in product presentation plumbing because the browser is their consumer. When a port/DTO becomes an agreement shared with backend/CLI, promote that subject to `solutions/contracts/<subject>` with the repository's required compatibility documentation. Reusable domain decisions and use cases belong in `solutions/capabilities/cloud/*`, `distribution/*` or `plugin/*`; no product `domain/` or `application/` folders.

Mock transport adapters are product-owned infrastructure. They simulate contracts and may reuse browser-safe pure policy functions; they must not import Bun SQL repositories, process runners or server composition. Server imports must never become reachable from `composition/browser.tsx`.

### 19.2 Dependency path

```text
Route page -> feature hook/view model -> typed service port
                                        |
                         composition injects implementation
                                        |
                         Mock adapter -> local state + clock + event bus

Future replacement:
                         HTTP adapter -> validated DTO mapping -> existing service
```

Components never call `fetch`, open WebSockets, read storage, instantiate repositories or import fixture objects directly. Adapter instances are created once per application session, not on every render.

Use React with TypeScript and the existing React Router dependency. Use a single established query-cache solution rather than hand-building request caching. The specific query/form/schema libraries are implementation choices to confirm against available dependencies; this plan does not prescribe versions or a new UI framework.

### 19.3 State ownership

| State | Owner |
|---|---|
| Current principal/session | Session port + session provider |
| Organization/project/environment selection | Authorized route scope |
| Resource data, permissions and operation status | Adapter; query cache is a projection |
| Filters/page/sort/tab | URL |
| Form draft/validation/touched fields | Feature form |
| Selected row IDs/expanded panel | Local presentation state scoped to query |
| Mock persistent records | MockStore adapter, not query cache |
| Live changes | Event port -> scoped cache invalidation |
| Feature availability | Capability catalog supplied by adapter |

Query keys include principal visibility context, organization, project, environment, resource, filters and pagination. Avoid wildcard cache invalidation across all organizations. Log out clears sensitive cache; scope changes abort previous requests. Responses arriving from an obsolete scope cannot populate the new scope.

### 19.4 Common operation types

Illustrative types, to be refined into compile-ready contracts during implementation:

```ts
type Scope = {
  orgId: string;
  projectId?: string;
  environmentId?: string;
};

type RequestContext = {
  scope: Scope;
  signal?: AbortSignal;
};

type CommandOptions = {
  idempotencyKey: string;
  expectedRevision?: string;
};

type Page<T> = {
  items: readonly T[];
  nextCursor: string | null;
  total?: number;
};

type ServiceError = {
  code: "unauthenticated" | "forbidden" | "not_found" |
    "validation" | "conflict" | "rate_limited" | "quota_exceeded" |
    "unavailable" | "unsupported_operation" | "cancelled";
  message: string;
  fieldErrors?: Readonly<Record<string, string>>;
  retryAfterMs?: number;
  requestId: string;
};

type Operation = {
  id: string;
  kind: string;
  state: "queued" | "running" | "cancel_requested" |
    "succeeded" | "failed" | "cancelled";
  completedSteps: number;
  totalSteps?: number;
  resourceId?: string;
  revision: string;
};
```

Scope is a requested context, not proof of permission. Ports resolve their principal independently. Account/visitor operations use their own public/account request context rather than manufacturing an org ID.

Use async ports, immutable DTOs, ISO-8601 UTC date strings and explicit serialization for decimals/bigints. Keep transport-specific status codes, Bun types and `Response` objects out of feature code. Normalize errors once in the adapter. Decide one Result/error convention for the implementation and use it consistently.

### 19.5 Service port inventory

These operations are frontend contracts, not claims about existing HTTP endpoint names. Every operation must have typed request/response, scope, allowed action, errors and mock behavior.

| Port | Query operations | Command/subscription operations |
|---|---|---|
| AccountSessionPort | getSession, listSignInMethods, listSessions | requestSignIn, completeChallenge, signOut, revokeSession, linkProvider, enrollMfa, recover |
| AccountPort | getProfile, listDevices | updateProfile, requestEmailChange, deleteAccount, authorizeDevice, revokeDevice |
| OrganizationPort | list/get organizations, members, invitations | create, update, invite, resend/revoke/accept invitation, changeRole, leave, transfer, delete |
| AccessPort | getEffectivePermissions, listAssignments | grant/revoke project/environment access |
| ProjectPort | list/get project, getSetup, getBindings | create, update, enableResource, archive, restore, delete |
| EnvironmentPort | list/get environments, getReadiness | create, update, pause, resume, delete |
| RepositoryPort | listConnections/repos/refs, inspectManifest, getProposal | connect, reconnect, disconnect, configureTrigger, proposeChange, simulateEvent |
| BuildPort | list/get builds, listStages/artifacts, getPreflight | start, retry, requestCancel, invalidateCache |
| LogPort | readLogPage | subscribeLogs, exportLogs |
| WorkerPort | list/get org workers, capacity | enroll, rotateCredential, drain, resume, remove |
| ReleasePort | list/get releases, getPreflight, inspectCompatibility | create/update/deleteDraft, publish, withdraw |
| ChannelPort | list/get channels, getHistory, getDeliveryObservations | create, pointToRelease, changeRollout, pause/resume, rollback |
| SigningPort | listKeys/certificates, getReadiness | registerReference, rotateKey, revokeReference |
| DatabaseCatalogPort | listSchemas/tables, getColumns/relationships/indexes | create/alter/drop schema objects |
| RowsPort | queryRows, getRow | insert/update/delete rows, import/export |
| SqlPort | listSavedQueries, getHistory | saveQuery, executeSupportedQuery, cancel, explain |
| PolicyPort | list/get policies | create/update/delete, enableRls, previewAccess |
| AppAuthPort | list/get users, providers, sessions, auth events | configureRealm, invite/create/update/suspend/delete user, revokeSessions, request/consume app challenge |
| StoragePort | list/get buckets/objects/versions, previewMetadata | create/update/delete bucket, beginUpload, finalizeUpload, copy/move/delete object, createAccessLink |
| VectorPort | list/get collections/points, search | create/update/delete collection, upsert/delete/import points, configureIndex |
| GraphPort | list/get nodes/edges, neighbors, shortestPath | create/update/delete nodes/edges, importGraph |
| FunctionPort | list/get functions/revisions/deployments/invocations | saveDraft, deploy, invoke, promote, rollback, disable/delete, cancelInvocation |
| SchedulePort | list/get schedules, nextOccurrences/history | create/update/pause/resume/delete, runNow |
| RealtimePort | getPublicationConfig, listAuthorizedConnections | configure, subscribe, unsubscribe |
| MigrationPort | list/get migrations, diff/preview | register, apply, retry, requestReverse |
| BackupPort | list/get snapshots, getCoverage/restorePlan | create, export, restore, delete, configureRetention |
| RegistryPort | search/get package/version, resolvePlan, getTrust | create/update package, submitVersion, publish, deprecate, transfer, report |
| ProjectPluginPort | list/get dependencies, getUpdatePlan, getImpact | add/update/remove/disable, setGrants, synchronizeProposal |
| CredentialPort | listCredentialMetadata, getUsage, listServiceAccounts | issue, rotate, revoke, createServiceAccount, updateServiceAccountGrants, disableServiceAccount |
| SecretPort | list/get secretMetadata, getDependents | create, replace, rotate, delete |
| BillingPort | getPlan/subscription/usage/invoices/budgets | startCheckout, confirmMockEvent, cancel/resume, updateDetails, setBudget |
| ActivityPort | listAudit/notifications, getPreferences | markRead, updatePreferences, subscribe |
| OperationPort | get/list operations | subscribe, requestCancel, retryAllowedStep |
| OperatorPort | getFleet/queue/tenantStatus/reviewEvidence | repairProvisioning, suspend/resume, reviewSubmission, revokeArtifact, rotateTrust, adjustUsage |
| TransferPort | getTransferStatus | uploadLocalFixture, downloadFixture, cancelTransfer |
| CapabilityPort | getAvailableCapabilities | none |

Split a large port by concern when needed; do not create one universal `execute(action: string, any)` service. Conversely, do not introduce an abstraction per button when operations belong to the same resource contract.

### 19.6 Port behavior contract

- Queries support cursor pagination, stable sorting, structured filters and cancellation where relevant.
- Commands carry idempotency keys and expected revisions for mutable resources.
- Long operations return an operation reference; resource state is read separately.
- Transfers expose progress/cancellation and return metadata plus a download handle rather than raw service URLs inside components.
- Subscriptions return an unsubscribe function and expose connection state, sequence/cursor and scope.
- Capability responses name supported actions and limits; an unknown feature is not silently enabled.
- Secret creation may return a one-time fake value. Later get/list calls cannot return it.
- Every DTO crossing a future HTTP boundary is validated and mapped; TypeScript casting alone is not validation.
- Do not silently fall back to mock data after a real-service error. Each adapter's mode is fixed by composition.

## 20. Stateful Mock System

### 20.1 Mock requirements

The mock is a local platform simulation behind the service ports. It must provide coherent persistent state and consequences, not page-specific arrays with unrelated success toasts.

Use one normalized MockStore with entity collections keyed by ID. For example, a new function deployment appears on function detail, environment overview, activity, usage and operation history. All of those read the same record.

Inject a clock, deterministic ID generator and seeded scenario source. Store fake data in versioned browser persistence, preferably IndexedDB for structured resources and blob fixtures. LocalStorage may store a selected scenario or UI preference, never real credentials. Persistence failure/quota overflow surfaces an error rather than pretending to save.

Use a clearly separate mock entry/build configuration. The frontend must start without the Cloud server, Postgres, MinIO, worker process or service environment variables. Mock fixtures and tools are excluded from a future production adapter build.

### 20.2 Simulation rules

1. All queries and commands are asynchronous with configurable latency.
2. Validate inputs and permissions in adapters; forms add early feedback but cannot bypass rules.
3. Material operations update related entities atomically within the simulation where the contract promises atomicity.
4. Emit events only after simulated commit. Event sequences are deterministic and deduplicated by cursor.
5. Build/provision/release/restore/invocation operations progress through scheduled states; closing a page does not stop them.
6. Persist operation deadlines/current step. On reload, reconcile elapsed time through the mock scheduler so work does not remain stuck forever.
7. Expose pause/advance clock in mock tooling for expiry, rollout windows and schedules. Avoid random failures changing on each render.
8. Idempotent resubmission returns the original resource/result. Same key with a different payload returns conflict.
9. Cancelled operations do not later report success unless the contract explicitly reports completion winning the cancellation race.
10. Return copies/immutable snapshots so a component cannot mutate persisted state by reference.
11. Allow resetting one scenario or the entire fake workspace after confirmation; version fixture schemas and handle incompatible stored state.
12. Model access revocation, missing resources, service outages, stale revisions and partial multi-service operations.
13. Never send email, call OAuth/payment/repository providers, fetch package bytes, open external checkout or invoke native tooling.
14. Download/upload examples remain local fixture data. File names/content types/bytes come through TransferPort.
15. Cross-tab behavior has a single coordinator or storage revision locking so timers cannot double-complete jobs. Broadcast committed changes to other tabs.

### 20.3 Seed scenario catalog

| Scenario | Fixture and purpose |
|---|---|
| Fresh visitor | No session, empty account state, mock verification inbox |
| New verified account | No organizations; create organization and first project |
| Working organization | Two projects, development/staging/production, distinct service bindings |
| Second tenant | Different members/resources with similar names; verifies visible scope semantics during walkthrough |
| Restricted developer | One project, no production data or publish grant |
| Billing-only member | Usage/invoices visible; no schema/customer data |
| Pending invitation | Valid, expired, revoked, wrong-email and already-accepted variants |
| Windows build lifecycle | Queued, running, failed packaging, signing unavailable, cancelled and succeeded examples |
| Worker outage | Expired lease, stale completion and replacement attempt |
| Release progression | Draft, beta cohort, stable, paused, withdrawn and incompatible rollback |
| Data workspace | User-owned notes table, public catalog, JSON documents, foreign-key conflict and disabled access |
| Private blobs | Private/public buckets, binary fixture, expired link and quota failure |
| Application users | Verified, unverified, suspended, provider-linked and expired-session users |
| Functions | Source draft, active revision, failed deployment, timeout, successful invocation and overlapping schedule |
| Vector/graph | Small deterministic vectors and connected/disconnected weighted graph |
| Plugin lifecycle | Valid Windows package, local plugin, permission expansion, incompatible ABI, deprecated and revoked versions |
| Billing transitions | Free, pro, near-limit, over-limit, checkout pending and payment failure |
| Backup recovery | Successful snapshot, partial coverage, failed resource restore and completed new environment |
| Operator | Review queue, suspended organization, draining worker and trust-key rotation |
| Partial service failure | Cloud available while Database/Registry fails; independent area errors |

All fixture relationships must be valid: users belong to their realms, rows reference existing fixture owners, artifact records belong to builds, releases reference those artifacts and dependency locks point to actual seeded package versions.

### 20.4 Failure controls

Mock tooling can select a named outcome for a specific operation: validation error, denied permission, session expiry, rate limit, quota exceeded, revision conflict, network-style unavailable, timeout, partial upload or uncertain command result. These are injected through adapters, not query parameters consumed by business components.

Default scenarios are deterministic and successful where appropriate. Failure injection is opt-in and visible only in mock tools. Pages do not contain `if (mock)` branches.

### 20.5 Cross-feature example

An organization owner invites a Developer, creates a project, enables development data and creates an app user. The Developer writes a user-owned row, sees a realtime event, uploads a private blob, deploys a fixture function that reads the row, and adds a plugin dependency. A Windows build records that dependency revision. The Owner publishes beta, widens the rollout and promotes stable. Usage and activity reflect the same actions. Revoking the Developer removes access from every page, not just Team.

This complete sequence must be possible using local mock state without touching any service or editing fixtures by hand.

## 21. Domain Records and State Machines

### 21.1 Minimum model fields

| Entity | Essential fields |
|---|---|
| CarbonAccount | id, verified identities, profile, status, security settings, createdAt |
| AccountSession | id, accountId, issuedAt, expiresAt, lastUsedAt, revokedAt, device metadata |
| Membership/Invite | orgId, accountId/email, role, assignments, status, expiry, inviter |
| Project | id, orgId, name, slug, repository binding, lifecycle, configurationRevision |
| Environment | id, projectId, kind/name, resource bindings, readiness, status |
| ServiceBinding | owner service, canonical scope, serviceResourceId, state, operationId |
| Build/Attempt | id, projectId, environmentId, immutable inputs, attempt, lease, stages, timestamps, status |
| Artifact | id, buildId, targetTriple, format/payloadKind, digest, size, signature state, retention |
| Release | id, projectId, version, environmentId, artifactRefs, sourceRevision, notes, publishedAt, status |
| Channel | id, projectId, name, releaseId, rollout, cohort, revision, pausedAt |
| Table/Column/Row | scope, stable IDs, schema/type metadata, key fields, revision, typed values |
| Policy | id, scope, resource, roles/actions, supported expression, enabled, revision |
| AuthRealm/AppUser | realm scope, identities, verification/status, public metadata, protected claims |
| Bucket/Object | scope, visibility/policy, object key/version, size, digest, owner, contentType |
| VectorCollection/Point | scope, dimension/metric, ID, vector, metadata, index state |
| GraphNode/Edge | scope, label/type, properties, endpoint IDs, weight, revision |
| Function/Deployment | scope, source digest/revision, config, bindings, active pointer, status |
| Invocation/Schedule | deployment, actor/trigger, payload reference, execution status, timezone, retry/overlap policy |
| Migration/Backup | scope, checksum/coverage, schema revision, operation, timestamps, retention |
| Package/Version | org namespace, immutable identity/version, artifacts, capabilities, provenance, trust/visibility |
| DependencyLock | project/config revision, package/version/target, digests, capability grants, synchronization status |
| Credential/SecretRef | owner/scope, audiences/actions, expiry/revocation, prefix, metadata/version references |
| Subscription/Usage | org, plan/version, period, state, meter, amount, source operation, adjustment |
| Audit/Notification | actor, scope, resource, action, outcome, safe diff, correlation, timestamp/read state |
| Operation | kind, scope, actor, request/idempotency ID, steps, state, revision, error/result references |

### 21.2 Lifecycle transitions

| Resource | Target states and rules |
|---|---|
| Account | unverified -> active -> suspended or deletion_pending -> deleted |
| Invitation | pending -> accepted/declined/expired/revoked; terminal invite cannot be reused |
| Project/environment | provisioning -> ready/degraded/failed; ready -> paused/archived/deleting; deletion -> deleted |
| Build | queued -> claimed -> running -> succeeded/failed; cancel_requested -> cancelled where supported; expired lease creates separate attempt |
| Release | draft -> publishing -> published or publish_failed; published -> withdrawn; never edit published artifact bytes |
| Channel | empty -> active -> paused -> active; each pointer update increments revision |
| App user | invited/unverified -> active -> suspended/deleted; session state tracked separately |
| Transfer | pending -> transferring -> finalizing -> complete/failed/cancelled |
| Function deployment | draft -> deploying -> active/failed; old active becomes superseded; rollback selects immutable compatible deployment |
| Invocation | queued -> running -> succeeded/failed/timed_out/cancelled |
| Schedule | enabled <-> paused; disabled/deleted stops future occurrences, not necessarily running invocations |
| Registry submission | draft -> validating -> awaiting_review -> approved/rejected -> published |
| Package version | published -> deprecated or revoked; visibility and signature validity are separate fields |
| Dependency | proposed -> approved -> pending_source_sync -> synchronized -> built; errors and revocation can block later stages |
| Backup | queued -> capturing -> complete/partial/failed -> expired; restore is separate operation |
| Subscription | free/active -> checkout_pending -> active/past_due/cancel_scheduled -> ended |

No state is represented solely by a button label. The adapter returns states plus available actions and reasons when a transition is unavailable.

## 22. Backend Handoff and Implementation Sequence

### 22.1 Backend implementation backlog

These are future changes inside existing products/capabilities. They are not authorized for implementation by this documentation task.

| Workstream | Backend deliverable | Depends on |
|---|---|---|
| BE-01 Identity | Human accounts, sessions, memberships, scoped tokens, role checks, challenge delivery and atomic consume | None |
| BE-02 Catalog | Cloud-owned projects/environments, resource bindings, provisioning operations and versioned configuration | BE-01 |
| BE-03 Tenant authorization | Resource ownership/audience checks on every route, SQL/database isolation, private blob enforcement, authorized realtime | BE-01/02 |
| BE-04 App auth | Realm-scoped users/sessions, provider settings, claims, revocation and data-policy context | BE-01/02/03 |
| BE-05 Windows builds | Isolated task execution, leases/attempts, cancellation, durable logs/artifacts, secret binding and accurate usage | BE-01/02/03 |
| BE-06 Releases | Project-scoped publication, immutable artifacts, manifests/channel revisions, Windows signing, compatibility metadata | BE-05; existing distribution capabilities |
| BE-07 Database lifecycle | Complete catalog CRUD, query contract, policies, blob transfers, vector/graph endpoints | BE-03/04 |
| BE-08 Functions | Constrained isolated execution, revisions/deployments, scoped invocation, schedule and retry state | BE-03/04/07 |
| BE-09 Registry | Namespace/publisher permissions, validated actual Windows archives, persistent trust, withdrawal/review | BE-01/03; existing trust capabilities |
| BE-10 Plugin consumption | Exact dependency resolution, grants, repository sync, extraction/staging/lock and build provenance | BE-05/09; existing lifecycle capabilities |
| BE-11 Operations | Persistent operation/audit records, per-resource subscriptions, retention and operator authorization | Across existing products |
| BE-12 Billing | Idempotent metering, subscription events, quotas, budgets and invoice metadata | BE-01/02/05/07/08 |
| BE-13 Recovery | Versioned migration tracking, snapshot coverage, retained resources and bounded restoration | BE-02/07 |

Cross-service mutations use explicit operations with independently recorded steps, retry keys and reconciliation. A Cloud project existing while Database provisioning fails is a recoverable degraded state; do not delete the Cloud project automatically. Each backend owns its own transactions. No frontend-managed distributed transaction.

### 22.2 Frontend implementation slices

All slices initially use mock adapters. Each slice includes routes, forms, permissions, states and connected mock consequences, not just page placeholders.

1. **Contracts and mock foundation:** agree identifiers/scope/error/pagination/revision conventions; browser composition; normalized fixture store; mock clock; capabilities; session injection; operations/events; scope-aware routes.
2. **Identity and platform shell:** account registration/sign-in, mock inbox, organization/membership/invitations, project/environment creation, permissions, account/security pages.
3. **Project configuration and credentials:** repository workflow, setup checklist, scoped API settings, secret metadata, device authorization and activity.
4. **Windows build and release flow:** stages/logs/attempts/workers/artifacts, draft/publish, channels/rollout/withdrawal, signing metadata and capability limits.
5. **Relational data and app authentication:** tables/rows/schema/policies/SQL fixtures, realm/users/providers/sessions and frontend/backend developer integration recipes.
6. **Data extensions:** binary blobs, vector/graph, realtime inspector, migration plans and backup/restore operations.
7. **Functions:** source drafts, isolated-contract mock execution, deployments, invocation details, schedules and secret bindings.
8. **Registry and plugin use:** catalog/version/publisher pages, review states, desired dependency/source synchronization, grants and build provenance.
9. **Billing and operators:** subscriptions/usage/budgets, operator queues/fleet/review, global failure scenarios and deletion/retention workflows.
10. **Consistency pass:** ensure every route/action has a contract and local outcome, stale/revoked context clears everywhere, mock persistence survives reload, and no service is contacted.

This sequence gives backend engineers stable contracts while frontend engineers implement meaningful workflows. Parallel work can later be divided by feature owner after slice 1; shared contract changes must be coordinated rather than copying models per feature.

### 22.3 Functional completion walkthroughs

This is a review checklist, not a request to build an automated test suite.

- Register a fake Carbon account, verify, create org/project and resume after reload.
- Invite another account, assign restricted access and observe denied production actions.
- Switch between two organizations with similarly named resources and see no stale data.
- Connect a fake repo, run/cancel/retry Windows builds, inspect signing and download a fixture artifact.
- Publish beta from a successful build, widen cohort, promote stable and inspect withdrawal/rollback limitations.
- Create table/policy/app user, write data as that user and receive only authorized realtime events.
- Upload binary fixture to private bucket; deny anonymous download; create and expire a mock link.
- Create vector points/graph edges and obtain deterministic query results.
- Save function source without executing it, deploy mock revision, invoke fixture and inspect failure/timeout/schedule history.
- Create migration and backup, restore to another environment and inspect skipped secret/session coverage.
- Submit Windows plugin fixture, review/publish it, approve dependency grants, simulate source sync and include it in a build.
- Revoke plugin version and observe blocked future resolution plus unchanged historical releases.
- Simulate checkout confirmation/failure, quota blocking and permitted billing-only navigation.
- Revoke account access while a query/stream is active and see scoped resources disappear.
- Exercise failed provisioning/partial restore/revision conflict without manually editing mock storage.
- Navigate every listed page directly, including empty/forbidden/not-found states.
- Confirm no existing Cloud, Database, Registry, payment, repository, email or native runtime integration is called.

### 22.4 Per-feature handoff contract

Before a feature is considered ready for backend integration, document:

1. Route and story IDs implemented.
2. Query/command/subscription names and DTO schemas.
3. Principal, audience, organization/project/environment requirements.
4. Validation rules, errors, permission-denial behavior and capability flags.
5. State transitions, idempotency, concurrency and cancellation behavior.
6. Mock fixture examples for success, failure and partial completion.
7. Side effects on activity, usage, notifications, dependencies and cache invalidation.
8. Data sensitivity, secret handling and retention obligations.
9. Current backend operation mapping or explicit missing backend work item.

Replace a mock adapter with HTTP only after that capability is implemented. Never invent a silent HTTP-to-mock fallback to make an incomplete backend appear healthy. The all-mock frontend remains a separate runnable mode for planning and demonstrations.

### 22.5 Product decisions still configurable

These do not block the mock architecture. Use the stated defaults until a deliberate product decision changes them.

| Decision | Planning default |
|---|---|
| Carbon account auth | Email magic link; configured GitHub option; MFA/recovery modeled |
| App auth identity scope | Separate realm per project/environment |
| Desktop target | Windows x64, NSIS default, optional MSI/WiX |
| Worker model | Carbon-managed fleet plus optional org-scoped self-hosted workers |
| Project/environment | One app per project; development initially, staging/production explicitly provisioned |
| Functions | HTTP + schedules using existing Cloud/Database structure |
| Database types | Relational/JSON, blobs, vectors and graph already represented in repository |
| Package visibility | Public catalog plus organization-private packages |
| Plugin namespace | Proposed org namespace with explicit mapping to existing local slug |
| Billing | Existing free/pro names; prices/extra quotas are mock data pending commercial decisions |
| Region/multi-region selection | No region selector until hosting actually supports placement choices |
| Update health metrics | Unknown until reported; fixtures marked simulated |
| Retention/legal policy | Configurable backend policy; no invented production retention guarantee |

## 23. Evidence Index

Paths below are relative to this document. They support the baseline and identify integration starting points; they are not imported directly by the future React pages.

- [Repository architecture](../../../ARCHITECTURE.md): product composition/presentation ownership, solution capability boundaries and product-owned adapters.
- [Current Cloud dashboard](../presentation/src/App.tsx): org-token signup, build list, logs/artifact UI and billing entry.
- [Cloud route surface](../infrastructure/http/routes.ts): authentication, app-user magic-link routes, build and billing operations.
- [Cloud identity schema](../infrastructure/persistence/migrations/0002_identity.sql): organizations and org/worker token model.
- [App-user schema](../infrastructure/persistence/migrations/0004_auth.sql): current org-scoped end users and sessions.
- [Cloud build model](../../../solutions/capabilities/cloud/orchestration/domain/entities/Build.ts): build inputs, transitions and artifacts.
- [Worker job flow](../../../solutions/capabilities/cloud/worker/application/usecases/RunNextJobUseCase.ts): claim, fetch, compile, package and upload.
- [Windows worker](../composition/worker-windows.ts): Windows packaging/signing composition.
- [Current log/artifact store](../infrastructure/persistence/BuildArtifactStore.ts): process-local maps separate from persisted build records.
- [Release publishing](../../../solutions/capabilities/distribution/publishing/application/usecases/PublishReleaseUseCase.ts): signing, upload and channel/version manifest assets.
- [Update contract](../../../solutions/contracts/update/types/UpdateManifest.ts): shared manifest fields.
- [Separate updater checker](../../carbon-updater/infrastructure/services/UpdateChecker.ts): separate client-side contract requiring compatibility reconciliation.
- [Database routes](../../carbon-database/infrastructure/http/routes.ts): current project operations, auth, storage and data access.
- [Database engine](../../carbon-database/infrastructure/services/DatabaseEngine.ts): SQL execution and table mutation behavior.
- [Database policy engine](../../carbon-database/infrastructure/services/RlsPolicyEngine.ts): current supported rule forms and context.
- [Storage engine](../../carbon-database/infrastructure/services/StorageEngine.ts): logical bucket metadata and S3 prefix layout.
- [Function engine](../../carbon-database/infrastructure/services/EdgeFunctionsEngine.ts): current storage and in-process execution.
- [Realtime server](../../carbon-database/infrastructure/http/server.ts) and [engine](../../carbon-database/infrastructure/services/RealtimeEngine.ts): subscription and publication behavior.
- [Database client](../../carbon-database/presentation/src/client.ts): existing developer-facing query surface to reconcile with future contracts.
- [Registry engine](../../carbon-registry/infrastructure/services/RegistryEngine.ts): package metadata, seeding, publishing and artifacts.
- [Registry composition](../../carbon-registry/composition/entrypoint.ts): shared identity and signing-key configuration.
- [Registry CLI path](../../carbon-cli/presentation/commands/plugins/plugin.command.ts): downloaded archive verification and current installation steps.
- [Local plugin installation](../../../solutions/capabilities/plugin/lifecycle/application/usecases/InstallPluginUseCase.ts): DLL/signature staging and app declaration responsibilities.
- [Cloud CLI](../../carbon-cli/presentation/commands/cloud/cloud.command.ts): current signup/login/deploy flow to migrate toward shared account authorization.
- [Current plan definitions](../../../solutions/capabilities/cloud/billing/domain/value-objects/Plan.ts): existing free/pro build-minute entitlements.
