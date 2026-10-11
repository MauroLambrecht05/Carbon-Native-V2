# Threat model

Who can reach the platform, what each can touch, what stands between them and
what they should not touch, and what is still exposed. It covers Carbon Cloud,
Carbon Database, Carbon Registry, the workers, the CLI and the console.

**Written by the author of the code, on 2026-10-11.** It is the walk through
principals and boundaries that the security checklist asked for
([security-review.md](security-review.md), item 1). It is not an independent
review: nobody whose job was to break the platform has read it or tested it
(G-159). Where a row says something is prevented, it names the test that shows
it; where it cannot, it says so.

## What is being protected

| Asset | Where it lives | What losing it means |
|---|---|---|
| A customer's rows, vectors, graph and blobs | Carbon Database: one PostgreSQL schema and role per environment; blob bytes in a bucket | One tenant reads or changes another's data |
| Environment secrets and provider secrets | Cloud's database, envelope-encrypted under a key custodian | Third-party systems of the customer are compromised |
| Signing keys: release signing, build provenance, Registry package signing, Cloud's assertion key | Environment secrets, or process configuration | Forged updates, forged packages, or forged authority between services |
| Credentials: sessions, `pt_`, `dc_`, `cs_`, `ce_`, `wc_`, `op_`, upload and transfer addresses | Shown once; stored as SHA-256 | Whoever holds one acts as its owner within its scope |
| The record of who did what | Event tables in each service, the organization log, operator actions | A change cannot be attributed, or a trace can be removed |
| Published packages and release artifacts | Buckets, with signed statements and manifests | Everyone who installs or updates receives something else |
| The platform's availability | Every service | Customers cannot build, release or serve their apps |

## Principals

| Principal | Proves itself with | Can reach |
|---|---|---|
| Anonymous | Nothing | Sign-in, public update feeds, public Registry packages and trust bundle, public blob objects, health endpoints |
| Account, in a browser | Session cookie, CSRF token, optionally TOTP | Everything its memberships and grants allow |
| Account, through a tool | `dc_` or `pt_` credential | Assertion exchange for one scope; builds, releases and functions in Cloud ([credential-api.md](credential-api.md)) |
| Service account | `cs_` credential | Assertion exchange for its exact scope |
| Environment credential | `ce_` | Its environment, with its listed permissions |
| App user | App session from an emailed link or OIDC | Rows in one environment, as themselves, under row policy |
| Worker | `wc_` credential, then a one-time lease token | The lease it holds: one build or one execution, and that lease's secrets |
| Operator | `op_` credential | The operator API: one organization at a time, with a reason |
| Cloud, to an owning service | An assertion signed with Cloud's key, bound to one request | What the assertion names, if Cloud confirms it when asked |
| The platform itself | An assertion whose principal is a recorded erasure | Erasing one environment in one owning service |
| Payment provider | A signature over the event body | Changing a subscription's recorded state |
| Whoever administers a deployment | Shell and database access | Everything. Not defended against |

## Trust boundaries

1. **Internet to Cloud.** Browsers, tools, workers, the payment provider and
   anonymous clients all arrive here.
2. **Cloud to Carbon Database and Carbon Registry.** Separate services with
   separate databases. They do not trust Cloud's network position, only its
   signed, request-bound assertions, and they ask Cloud to confirm each one.
3. **Tenant to tenant.** Inside each service.
4. **Customer code to the platform.** A build's scripts and a function's code
   run on a worker.
5. **Registry to everyone who installs.** A package crosses from one
   organization to machines that have never heard of it.
6. **Cloud to an installed app.** The update feed.
7. **Operators to customers.**

## Threats by boundary

### 1. Internet to Cloud

| Threat | What stops it | Shown by |
|---|---|---|
| A page of another origin acts with a signed-in user's cookie | Commands need a CSRF token matching the session and the configured `Origin`; cookies are `SameSite=Lax`, `HttpOnly`, `__Host-` | "denies cross-origin mutations, invalid redirects, extra secret fields and oversized bodies" |
| A stolen credential is used beyond its purpose | Every credential has an exact scope and permission list, checked with the account's current access on each use; a tool credential is taken only on named routes and never beside a cookie | The credential tests in `account-auth.integration.test.ts`, including "a device or personal credential reaches builds, releases and functions..." |
| A credential outlives the access it was issued under | Any change to an account's permissions retires its credentials; suspension, archive and deletion stop every kind | "suspension, archive and scheduled deletion stop every credential type" |
| Guessing or replaying a sign-in link or code | Single use, short-lived, rate limited by a keyed digest of the address and the peer | The registration and rate-limit tests |
| A forged provider event changes a subscription | Signature over the exact bytes, five-minute window, applied once by provider identifier, never moved backwards | The billing test |
| A response carries something it should not | One JSON shape for errors with no internal text; request logs carry routes, not paths or values | `operations.test.ts` |
| Enumerating other tenants' identifiers | Another tenant's resource answers `404`, the same as a missing one | "two-tenant denial matrix" (69 cases) |
| Flooding | Rate limits on sign-in, device polling and worker enrollment only | **Not covered elsewhere.** No general rate limit, no limit on authenticated worker calls (G-18), public feed and public downloads unlimited (G-60, G-80) |

### 2. Cloud to the owning services

| Threat | What stops it | Shown by |
|---|---|---|
| A request to Database or Registry that Cloud did not make | Ed25519 assertion, valid 60 seconds, bound to audience, scope, permission, method, path and body digest | `service-assertions.test.ts`; "receivers reject replay, wrong audience, tampered scope and stale leases" |
| Replaying a captured assertion | Each is consumed once | Same |
| Using an assertion after access was revoked | The owning service asks Cloud whether the authority is still current, and for changes asks again before committing | "a live authority change before receiver commit rolls back native DDL and grants" |
| A Database assertion presented to Registry, or the reverse | The audience is part of the assertion and of Cloud's answer | "Registry assertion exchange reaches only Registry: audiences cannot cross" |
| Erasing an environment that is not deleted | Only the platform principal is accepted; Cloud confirms only an erasure on record for a final deletion, for that service and resource, with no legal hold | "final deletion erases an environment in the owning services..." |
| Theft of Cloud's assertion signing key | **Partly.** The owning service's confirmation call means a forged assertion is honoured only if Cloud would also say yes, so the key alone does not grant erasure or access that Cloud has no record of. It does let its holder act as any account for whatever that account may currently do. Rotation with overlap exists and is proven at the verifier, not across running services (G-163). The key is process configuration, not held in a KMS |

### 3. Tenant to tenant

| Where | What stops it | Shown by |
|---|---|---|
| Carbon Database | A PostgreSQL schema and role per environment; row policies enforced by the database | "ensure, pause and resume provision real native resources and preserve cross-environment PostgreSQL privilege boundaries" |
| Cloud and Registry | Every query is scoped by organization, project and environment, with foreign keys carrying the scope | The denial matrix and a cross-tenant section in each feature's test |
| Cloud and Registry, if a query forgets its scope | **Nothing.** Neither database has row-level security behind the application (G-160) |
| Blob storage | Private objects are reachable only through a single-use address bound to one object | The blob storage test |
| A reference revealing that another tenant's key exists | **Not prevented** for foreign keys within one environment across policies (G-69) |

### 4. Customer code on a worker

This is the weakest boundary and it is not defended.

| Threat | State |
|---|---|
| A build script or a function reads the worker's files, credentials or other tenants' workspaces | **Not prevented.** Code runs as the worker's own user, with no container, VM or restricted account (G-38, G-100) |
| It exhausts CPU, memory or disk, or calls anywhere on the network | **Not prevented.** Only wall time, output size and log size are bounded |
| A secret reaches a log or an output | Exact values of the lease's secrets are removed on the worker before anything is sent. An encoded or split secret is not recognised (G-46, G-106) |
| A worker overwrites another build's artifacts | **Not prevented.** The worker holds write access to the whole artifact bucket; Cloud verifies an artifact once, before accepting success (G-42) |
| A compromised worker claims work it should not have | It can claim only leases for its organization and purpose, gets only that lease's secrets, once, and loses the lease if it stops heartbeating | The worker and lease tests |

Until this boundary exists, workers must be treated as trusted and must run
only code from organizations that trust each other. That is a condition on any
deployment, not a property of the code.

### 5. Registry to installers

| Threat | What stops it | Shown by |
|---|---|---|
| A malicious archive (traversal, links, bombs) | Inspected before storage, before signing, and by the installer before anything is written; nothing is executed during inspection | `registry-publishing.test.ts` |
| A package Registry never published | The installer checks Registry's signed statement against a root key pinned in the project | "packages are published only through an owned name, an exact upload and an operator review..." |
| Rolling an installer back to a bundle where a revoked key was valid | The installer remembers the highest trust-bundle sequence it has seen | The rotation drill |
| Taking over a publisher name | Names are owned by an organization and never reused | Same publishing test |
| A malicious but well-formed plugin | **Operator review only.** No malware scan, no check that the binary matches its declared capabilities, no reproducible build (G-117). Review is a command-line tool with a typed operator name (G-114) |
| Theft of Registry's signing key | A new root-signed bundle revokes it. The key is a seed in configuration, not in a KMS (G-115). There is no procedure for the root key itself |

### 6. Cloud to an installed app

| Threat | What stops it | Shown by |
|---|---|---|
| A forged update | The manifest is signed with the channel's key; all three updaters verify it and agree on the same conformance fixture | The update conformance tests |
| Hiding a withdrawal from an install | **Not prevented.** The stop list is not signed (G-52) |
| Downgrade | The updaters refuse an older version and honour `min_version` | Conformance fixture |
| Compromise of a release signing key | **No rotation.** A profile is fixed to one key (G-53) |

### 7. Operators

| Threat | What stops it |
|---|---|
| An operator acts as a customer | There is no impersonation. The operator API takes operator credentials only and refuses cookies and browser origins |
| An operator acts without a trace | Every act needs a reason and is written to a record that cannot be changed or removed |
| One operator deletes an organization early | A second operator must approve |
| A stolen operator credential | **Weak.** A bearer credential issued from the command line: no sign-in, no second factor, no network restriction, no rate limit (G-141) |

## What is not defended at all

Stated plainly, because a reader should not have to infer it from a table:

1. **Whoever runs a deployment.** Database and shell access is total access.
   Secrets are encrypted at rest, and the key custodian can be a KMS, but Cloud
   decrypts them in its own memory to deliver them.
2. **Code on workers** (boundary 4).
3. **Denial of service** beyond the three rate limits named above.
4. **A mistake in a query in Cloud or Registry** (G-160).
5. **Loss of data.** There are no backups (G-135).

## Changes that would move the most risk

In the author's estimate, in this order:

1. Isolate builds and functions (G-38, G-100).
2. Hold the assertion key, Registry's signing key and release keys in a KMS
   (G-54, G-115), with the adapter proven against the real service (G-01).
3. Backups with a proven restore (G-135).
4. Operator sign-in with a second factor (G-141).
5. Row-level security in Cloud's database, or a decision that the denial
   matrix is the control (G-160).
6. General rate limiting (G-18, G-60, G-80).
7. An independent review of all of the above (G-159).
