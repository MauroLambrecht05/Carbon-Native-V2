# Security and privacy checklist

The release checklist from section 27 of
[the backend plan](platform-backend-plan.md), item by item: what the code does,
where that is tested, and what is still open.

**This is a self-review by the author of the code.** It is not the independent
security review the plan requires before customer data is admitted. That review
has not happened (G-159). Treat every "met" below as "the author believes so
and points at a test", not as a finding by someone whose job was to break it.

Tests named here that use PostgreSQL run in CI's `integration` job, on Linux,
against real PostgreSQL and an S3-compatible store.

## Summary

| # | Item | Status |
|---|---|---|
| 1 | Threat model reviewed for every principal and trust boundary | **Not met.** No threat model document exists |
| 2 | Cookie, CSRF, CORS, CSP, redirect and session-fixation protections | Met in code and tests; not verified in a browser |
| 3 | No passwords | Met |
| 4 | Tokens and secrets one-time, hashed or encrypted, redacted, rotation-tested | Met, with one exception: function outputs |
| 5 | Service assertions audience-bound, short-lived, replay-aware, rotation-compatible | Met |
| 6 | Tenant isolation in application and datastore layers | Met for what is built |
| 7 | SQL and function execution sandboxed and resource-bounded | **Not met** |
| 8 | Upload and archive handling | Met for Registry archives and blobs |
| 9 | Explicit visibility for public objects; no guessable private keys | Met for what is built |
| 10 | Payment data stays with the provider; webhook signatures and replay windows | Met; never run against the provider |
| 11 | Deliberate policies for export, deletion, audit and backup retention, operator access | **Partly.** Operator access yes; retention mostly undecided |
| 12 | Dependency and container scanning, SBOM, signed releases, patch procedure | **Partly.** Scanning, SBOM and procedure yes; signed service images no |
| 13 | Independent security review | **Not done** |

## Item by item

### 1. Threat model

Not written. The trust boundaries are described piecemeal in the feature
documents ([signed-data.md](signed-data.md), [workers.md](workers.md),
[registry-publishing.md](registry-publishing.md),
[billing-operators.md](billing-operators.md)), but nobody has walked each
principal against each boundary in one place (G-159).

### 2. Browser protections

| Protection | What the code does | Evidence |
|---|---|---|
| Cookies | Session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` and `__Host-` prefixed on HTTPS | `account-auth.integration.test.ts`, registration and session tests |
| CSRF | Every command needs a token that matches the session; the token cookie is the only one the page can read | "denies cross-origin mutations, invalid redirects, extra secret fields and oversized bodies" |
| Cross-origin | Commands from another `Origin` are refused; the operator API refuses any request with a cookie or an `Origin` | Same test; the operator test |
| CSP | API responses: `default-src 'none'`. The console: scripts, styles and connections from its own origin only, no framing | `live.test.tsx`, the serving test |
| Redirects | `returnTo` must be a path of the console's own route table | Same cross-origin test; `safeReturn` |
| Session fixation | A new session is issued at sign-in and the pre-sign-in browser proof is cleared; sessions rotate on security changes | Registration and MFA tests |

Not verified in a real browser: nothing here has run in Chrome or Firefox
(G-151).

### 3. Passwords

There are none. Accounts sign in by emailed link, optionally with TOTP, or
through GitHub. App users sign in by emailed link or OIDC.

### 4. Tokens and secrets

- **One-time disclosure:** every credential (`ce_`, `cs_`, `pt_`, `dc_`, `wc_`,
  `op_`, upload and transfer addresses) is returned once and stored as a
  SHA-256 hash. Evidence: each credential's test asserts the stored rows do not
  contain the token.
- **Encryption at rest:** environment secrets and provider secrets are
  envelope-encrypted under a key custodian (local AES or AWS KMS). The KMS
  adapter has never run against AWS (G-01).
- **Redaction:** build logs are redacted on the worker before sending; request
  logs carry no values at all and failure text is redacted
  ([operations.md](operations.md)). Evidence: `operations.test.ts`; the build
  worker test.
- **Rotation:** see the rotation table in [operations.md](operations.md).

Open: a function can return a secret as its output, and outputs are stored
readable (G-106). Encoded forms of a secret are not redacted from build logs
(G-46).

### 5. Service assertions

Signed with Ed25519, valid 60 seconds, bound to one audience, one scope, one
permission, one method, one path and one body digest, usable once, and checked
against Cloud again before the owning service commits. Evidence:
`service-assertions.test.ts` (audience, permission, resource, request and
principal confusion; expiry; revoked and unknown keys; rotation overlap), and
the cross-service tests in `platform-lifecycle.integration.test.ts`.

### 6. Tenant isolation

- **Application layer:** every request resolves the caller's access to the
  exact organization, project and environment in the same transaction as the
  work. Another organization's identifiers answer `404`. Evidence: "two-tenant
  denial matrix" (69 cases), and a cross-tenant section in each feature's test.
- **Datastore layer, Database:** each environment has its own PostgreSQL schema
  and role, and row policies are enforced by the database. Evidence: "ensure,
  pause and resume provision real native resources and preserve
  cross-environment PostgreSQL privilege boundaries".
- **Datastore layer, Cloud and Registry:** one shared schema, isolated by
  scope columns and foreign keys. There is no row-level security in Cloud's or
  Registry's own database: a bug in a query is not caught by the database
  (G-160).

### 7. Sandboxing

Not met.

- **Functions** run as an unisolated child process of the worker, with no CPU,
  memory, disk or network limit (G-100).
- **Builds** run as the worker's own user (G-38).
- **SQL:** there is no customer SQL at all; data access is through typed
  commands. Restricted SQL is not built (G-64).

### 8. Uploads and archives

- **Registry archives:** one bounded zstd frame, plain files only, portable
  paths, no links, no traversal, bounded expansion, inspected before storage
  and again before signing, and again by the installer before anything is
  written. Nothing is executed during validation. Evidence:
  `registry-publishing.test.ts` (every refusal category).
- **Blobs:** exact declared size and digest, single-use transfer, verified
  before storing. Evidence: the blob storage test.
- **Imports:** bounded, staged and encrypted. Evidence: the import tests.

Open: a library is checked by its header only (G-117); there is no malware
scanning anywhere.

### 9. Visibility

- Blob objects are private unless their bucket is public at the moment of the
  request; private objects are reachable only through a single-use transfer.
- Registry packages are public once published; unpublished versions are not
  listed or served. Every published package is public (G-119).
- Update manifests are public and signed.
- Storage keys are not derived from anything guessable to another tenant, and
  no endpoint serves by raw storage key.

### 10. Payments

Cloud stores no card data: checkout happens on the provider's page. Provider
events are accepted only with a valid signature over the exact bytes, within a
five-minute window, and each is applied once. Evidence: the billing test.
Never run against the real provider (G-136).

### 11. Policies

| Policy | State |
|---|---|
| Operator access | Decided and enforced: separate accounts, scoped roles, reasons, a permanent record, no impersonation ([billing-operators.md](billing-operators.md)) |
| Deletion | Scheduled, recoverable for a window, gated by legal holds and live subscriptions. Final deletion erases the environment's data in Database and Registry on Cloud's recorded instruction ([resource-lifecycle.md](resource-lifecycle.md)). Cloud's own rows and artifacts are kept (G-09) |
| Data export | Table exports exist, private and single-use. No account-level export of everything Carbon holds about a person |
| Audit retention | Undecided. Events are kept forever |
| Backup retention | No backups (G-135) |
| Retention of executions, usage events, review records, invoices | Undecided; kept forever (G-106, G-146) |

### 12. Supply chain

Partly met. A workflow audits the JavaScript and Rust lockfiles, writes a bill
of materials, and builds, starts and scans each service image; the procedure
for a failure is in [supply-chain.md](supply-chain.md). Builds produced by the
platform get signed provenance; the platform's own service images are not
signed or published (G-161).

### 13. Independent review

Not done (G-159).

## What an independent reviewer should look at first

In the author's own estimate, where a mistake would cost the most:

1. `PostgresPlatformAuthority.resolveInTransaction` and
   `PostgresServiceAuthority.isCurrent`: every authorization decision goes
   through one of these.
2. The account routes' cookie, CSRF and origin handling, in a real browser.
3. `inspectArchive` and `verifyRegistryPackage`: what an installer trusts.
4. `verifyStripeWebhookSignature` and the billing inbox.
5. The worker: what a build or function can reach on the machine it runs on.
6. Cloud's own database, which has no row-level security behind the
   application's checks.
