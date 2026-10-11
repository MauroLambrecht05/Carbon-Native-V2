# Gap ledger

Every item the platform work has left not done, not proven, or deferred. Add an
entry in the same commit that creates the gap, and move it to "Closed" in the
commit that closes it. A phase is not reported as finished until its gaps are
here.

Each entry says what is missing, where it came from, why it is open, and what
would close it.

**Where these get done.** By the owner's decision on 2026-10-10, open decisions
and everything a phase could not finish or prove are worked in one final phase,
Phase 19 in [handoff.md](handoff.md), after the planned phases. A phase does not
stop for them: where a decision was needed to keep going, a default was chosen
and is recorded in the entry. An entry that names an earlier phase as its owner
is closed there if that phase's own work reaches it, and otherwise falls to
Phase 19 as well.

## Open: needs something from outside the repository

| # | Gap | From | Why open | Closes when |
|---|---|---|---|---|
| G-01 | The AWS KMS custody adapter has never run against real AWS | Phase 4 | No AWS account or key was available; it is tested against the published signature example and a stand-in | A wrap/unwrap round trip and a key rotation succeed against a real KMS key |
| G-02 | The OIDC client has never run against a real identity provider | Phase 6 | No provider tenant was available; it is tested against a stand-in with real signatures | A sign-in completes against at least one real provider |
| G-03 | No production deployment, restore, rotation or cutover evidence exists for anything | All | Nothing has been deployed | Phase 18 |

## Open: needs a decision

| # | Gap | From | Decision needed |
|---|---|---|---|
| G-04 | Legacy `cc_` token hashes are never deleted | Phase 3 | The published expiry window after which retired or all legacy tokens are purged |
| G-05 | Legacy organization-wide end users (`/v1/end-users/*`) are not migrated into realms | Phase 6 | Whether to migrate them, and to which environment's realm, or retire the routes |
| G-06 | Hosted key custody is AWS KMS only | Phase 4 | Whether another provider is required; the custody port allows it |

## Open: later phase owns it

| # | Gap | From | Owner |
|---|---|---|---|
| G-07 | The legacy `wk_` worker tokens and legacy build queue routes (`/v1/builds`) still work, separate from canonical builds | Phases 3, 4, 7 | Phase 7 built canonical builds but did not retire or bridge the legacy queue: the CLI's `carbon cloud deploy` and the Linux worker still use it. Retire with the CLI work in Phase 15 |
| G-08 | Suspension and reinstatement have no operator HTTP surface | Phase 5 | Phase 16 |
| G-09 | Final deletion marks rows in Cloud and destroys no data in Carbon Database, Carbon Registry or object storage | Phase 5 | Needs a delete action in the owning-service lifecycle protocol; Phase 16 (recovery and deletion) |
| G-11 | The CLI uses only the device login; it cannot use personal credentials | Phases 3, gap closures | Phase 15 |
| G-12 | The production frontend is the mock; no screen is wired to the real API | All | Phase 17 |

## Open: not started, no owner yet

| # | Gap | From | Notes |
|---|---|---|---|
| G-13 | App users have no passwords, passkeys or MFA | Phase 6 | Email links and OIDC only |
| G-14 | App users have no custom claims or roles; row policies see the user ID only | Phase 6 | |
| G-15 | App users cannot be exported | Phase 6 | The plan lists export under BE-04 |
| G-16 | Events have no retention policy and no export, and the stream never sends a `gap` frame | Phase 5 | |
| G-17 | Account-level security events (sign-in, MFA, sessions) are not in the organization log | Phase 5 | They are account-scoped, not organization-scoped |
| G-18 | Authenticated worker calls are not rate limited; only enrollment is | Phase 4, gap closures | |
| G-19 | Envelopes cannot be moved between custody modes (local keyring to KMS) | Phase 4 | Choose the mode before storing secrets |
| G-20 | Members are not notified when a deletion is scheduled | Phase 5 | |
| G-21 | Owning-service events (Database, Registry) are not in the organization log | Phase 5 | |
| G-22 | The event stream polls the database once a second; there is no broker | Phase 5 | Acceptable until load says otherwise |

## Open: from Phase 7 (builds)

| # | Gap | Why open | Owner |
|---|---|---|---|
| G-28 | A build's input is a repository, commit, targets, secret names and platform. The lockfile digest, configuration digest and tool versions are recorded in provenance after the build; the toolchain is not pinned before it, so two attempts can use different tool versions | Pinning needs a toolchain manifest in the input and workers that install exactly it | Needs a Windows build host (with G-36) |
| G-29 | The repository URL and commit SHA are supplied by the caller; a build is not created from a branch or tag through the repository integration, `repositoryId` is optional, and the URL is not checked against the project's bound repository | Resolution exists (`RepositoryCommitResolve`) but is not chained into build creation | Do together with G-40 |
| G-30 | There is no dedicated build permission; creating a build needs `release.publish` | Adding one changes the permission vocabulary and role presets | Needs a decision |
| G-32 | Build logs are read by polling `?after=N`; they are not on the event stream | The stream carries events, not log text | Phase 17 decides the UI need |
| G-33 | The reservation is a fixed 30 minutes, the deadline equals it, and attempts are fixed at three | No per-plan or per-build policy yet | Phase 16 (quotas) |
| G-34 | Quota reads the legacy `org_plans` and `usage_records` tables, whose organization column is text | Billing is rebuilt in Phase 16 | Phase 16 |

## Open: from Phase 8 (build execution)

Phase 8's proof gate is "a clean Windows worker builds a pinned commit under
resource and egress limits and emits verified immutable artifacts and
provenance". The pinned commit, verified artifacts and provenance are proven.
The rest of the gate is not, and is listed here.

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-36 | No real Carbon app has been compiled or packaged by the build worker. `CarbonBuildPipeline` hands off to `RealLocalPipeline` (bun install, runtime build, NSIS, WiX), and that path has never run under the worker; the tests use a stand-in pipeline. The worker has also only run on Windows 11 on a developer machine, not a clean host | The development machine has no NSIS (`makensis`) or WiX, and a real build was not attempted | A clean Windows x64 host with the toolchain builds a sample app to a working `nsis` and `wix` installer through a real lease |
| G-37 | Authenticode signing from lease secrets (`WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`) has never run | No signing certificate and no `signtool` run | A signed installer from the worker passes `signtool verify` |
| G-38 | A build is not isolated or limited. It runs as the worker's own user with that user's files and network, with no CPU, memory, disk or egress limit, and not in a container or VM. Only the workspace directory is disposable | Needs an isolation mechanism (Windows job objects and a restricted user, or a VM per build) and a decision on which | The proof gate's "resource and egress limits" passes on a real host |
| G-39 | Compiler, installer and `bun install` output is not captured into the build log: those processes write to the worker's own console. Only the worker's stage lines reach Cloud, and nothing redacts the console | `RealLocalPipeline` runs subprocesses with inherited output | The pipeline streams subprocess output through the worker's redacting log |
| G-40 | Private repositories cannot be built: the checkout uses no credential | Needs a short-lived repository token (GitHub App installation token) delivered with the lease | A private repository bound to the project builds |
| G-41 | The provenance signing key has no published public key, no rotation list and no revocation; consumers must be given the key out of band. The statement is Carbon's own format, not in-toto or SLSA | Publishing keys belongs with release signing | Phase 9 (releases) |
| G-42 | The worker holds write access to the whole artifact bucket. Cloud verifies an object once, before accepting success; an object replaced afterwards is not detected, and a worker could overwrite another build's objects. Objects are not write-once | Needs per-build upload grants (presigned URLs under the build's prefix) and object immutability or versioning in the bucket | Phase 11 (blob storage) or sooner if workers are not all trusted |
| G-43 | Cloud verifies an artifact by reading the whole object inside the completion request. Large installers make that request slow, and there is no size-based timeout or background verification | Simple first implementation | Verification moves to a job, or measured limits are documented |
| G-44 | The artifact store test runs only when `CARBON_OBJECT_STORE_TEST_*` is set. It passed against a local MinIO container; CI does not run it, and it has not run against AWS S3 or Cloudflare R2 | CI has no object store service | CI starts MinIO, and one run against a real provider is recorded |
| G-45 | The lockfile rule covers a bun lockfile at the repository root only. A project in a subdirectory or a workspace package is not supported, and `Cargo.lock` is digested when present but not required | Carbon apps today are root-level bun projects | A project layout that needs it |
| G-46 | Log redaction removes exact secret values and the lines of multi-line values. An encoded form of a secret (base64, URL-encoded, split across lines) is not removed | Exact matching only | A decision on which encodings to cover |
| G-47 | Objects uploaded by failed, cancelled and lost attempts stay in the bucket forever | No cleanup job | Phase 11 (retention and cleanup) |
| G-48 | Cancellation stops the worker between steps. A compile or package step already running is not killed, so a cancelled build can keep using the machine until that step ends | `RealLocalPipeline` does not take the abort signal | Subprocesses are terminated on cancellation |
| G-49 | The worker removes only its own settings from the environment. Any other secret in the worker machine's environment is inherited by builds. The worker credential is not rotated automatically, and the `build-worker.ts` loop has no test beyond its settings handling | Depends on G-38 for a real boundary | With G-38 |

## Open: from Phase 9 (releases)

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-51 | An artifact is signed by reading it whole into Cloud's memory, so anything over 512 MiB cannot be released | Ed25519 signs a whole message; the existing updaters verify that form | Artifacts are signed where they are built, or the contract moves to signing a digest |
| G-52 | The stop list (`yanked.json`) is not signed. Someone who can alter traffic can hide a withdrawal from an install, though not forge an update | The existing updaters read an unsigned stop list | A signed stop list is added to the update contract and every updater |
| G-53 | An update signing key cannot be rotated. A profile is fixed to one key, and the manifest's `keyring.secondary` is always empty | Rotation needs the overlap rules of `@carbon/signing`'s keyring wired into profiles and manifests | A rotation with an overlap window passes the conformance fixture |
| G-54 | Signing keys are environment secrets: encrypted at rest under the configured custody, decrypted in Cloud's memory for each signature. The plan asks that private keys never enter Cloud tables; the encrypted form does. Default chosen: reuse the secret store | Signing inside a KMS or HSM needs a provider and a decision | A custody adapter signs without exporting the key |
| G-55 | A release's compatibility is `min_version` only. The plan also lists the data environment and migration warnings | Those belong to data migrations (Phase 10) | Phase 10 |
| G-56 | Nothing schedules a rollout, widens it over time, or halts it when installs crash | No health signal reaches Cloud; the plan forbids device telemetry unless the app enables it | A decision on telemetry |
| G-57 | No packaged app has updated itself from this feed. The three updaters agree with the publisher on signatures and decisions through the shared fixture, and Cloud's feed is checked with the TypeScript updater's code, but download, slot swap and restart against a Cloud release have not run | Needs a real packaged build (G-36) | A packaged app on version N updates to N+1 from a Cloud channel and rolls back after a withdrawal |
| G-58 | `products/carbon-updater` (the standalone daemon) is not the canonical updater and still exists. Its local HTTP surface takes the trusted key and a manifest from the request body with open CORS | Default chosen: keep it conforming, mark it non-canonical | A decision to harden or remove it |
| G-59 | The CLI still publishes through the older path (`carbon publish` straight to S3, `PublishReleaseUseCase`, `RollbackReleaseUseCase`, `YankReleaseUseCase`), which bypasses Cloud releases, their audit trail and their immutability | CLI work is Phase 15 | Phase 15 |
| G-60 | The public feed is read from the database on every request, with a 60-second cache header and no rate limit or CDN | Acceptable until load says otherwise | Phase 18 |
| G-61 | A paused environment's feed answers 404, so its installs see no updates and no stop list while it is paused. Default chosen: only an active environment serves a feed | Needs a product decision on what "paused" means for shipped apps | A decision |
| G-62 | Withdrawing a release leaves its artifacts in the bucket and reachable by URL | No object lifecycle yet | Phase 11 |
| G-63 | A channel shows its latest 100 revisions; older ones are stored but cannot be listed. Releases cannot be filtered by state | Paging was not needed yet | When a channel passes 100 revisions |

## Open: from Phase 10 (relational data)

Phase 10 delivered foreign keys with cross-table impact previews and private,
resumable exports. Its plan line also lists asynchronous schema work, migration
promotion and restricted SQL, which were not built. They are the first four
entries here.

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-64 | **Restricted SQL is not built.** There is no administrative SQL surface: no saved queries, no asynchronous SQL jobs with cancellation and statement timeouts, no allow/deny matrix, no redacted history | Not reached in Phase 10. The legacy Database raw-SQL route still exists and is not hardened | A restricted-role SQL job runner with a published matrix passes tenant-isolation tests |
| G-65 | **Migration promotion is not built.** A schema cannot be compared between environments or promoted from one to another | Not reached in Phase 10 | A reviewed plan promotes a schema between two environments and reports what it would change first |
| G-66 | **Schema changes are synchronous.** A change runs inside one request with a five-second statement timeout, so a change that rewrites or validates a large table fails instead of running as a job | Not reached in Phase 10 | Long schema changes run as cancellable jobs with progress and recovery |
| G-67 | **A table cannot be deleted.** There is no `table.delete`, and so no impact preview for one | The catalog keeps audit rows that reference the table; deletion needs a retired state | Tables can be retired with a preview that lists inbound foreign keys |
| G-68 | Foreign keys are single-column, reference only a primary key, and never cascade. There is no `set null` or `cascade`, and no composite key | The simplest safe form first | A need for them |
| G-69 | PostgreSQL checks foreign keys without row policies, so a writer to a referencing table can learn whether a key exists in a table they cannot read | Inherent to native foreign keys | A decision: accept, or check references under policy in application code |
| G-70 | An export ends when its creator's session ends or expires, even mid-run, because the job re-resolves that session's authority at every claim. Imports behave the same way | Background jobs have no identity of their own | Jobs act under a durable grant instead of a browser session |
| G-71 | An export contains only rows its creator's policy-preview access can read. There is no administrative export of every row | The data API has no administrative row access by design | A separately audited administrative path |
| G-72 | Exported rows are always in ID order; a custom sort is not supported. Exports cannot be listed beyond the latest 50 | Keyset paging by ID is what makes resuming exact | A need for it |
| G-73 | If a worker dies after writing a part and before recording it, and the job is then cancelled or fails, that one object is never deleted: the sweep only knows recorded parts | The store port has no listing | The sweep lists a job's prefix, or the bucket gets a lifecycle rule |
| G-74 | `S3ExportStore` has run only against a local MinIO container, in a test CI skips; the job tests use an in-memory stand-in for the bucket. A download streams each part through Cloud's memory (up to one page of rows at a time) | CI has no object store | The export tests run against MinIO in CI (with G-44), and once against a real provider |
| G-75 | The export worker's entry point (`data-export-worker.ts`) and the `CARBON_DATA_EXPORTS` configuration have no test of their own | Small glue | A configuration test |

## Open: from Phase 11 (blob storage)

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-76 | App users have no blob access. Only accounts and service accounts can use blob commands; an app can reach only public objects | Needs an object ownership rule and app-user assertions for blobs | An app user uploads and reads their own objects, and cannot reach another user's |
| G-77 | An object is limited to 256 MiB and is held in memory while it is uploaded, verified and downloaded | Verification before storing is done on a buffer | Streaming or multipart transfer with verification |
| G-78 | Transfers go through Carbon Database, not through presigned object-store URLs as the plan describes. Database carries every byte in and out | A presigned PUT cannot enforce an exact size and digest before the object exists | A decision: keep service-mediated transfers, or presign and verify on completion |
| G-79 | A download address stays usable for its 60 seconds even if the caller's access is revoked in that time. Database has no assertion to recheck when the address is used | The address deliberately carries no session | Addresses bound to a recheck, or a shorter lifetime |
| G-80 | A public object can be cached for up to 60 seconds after its bucket is made private. Public downloads are not rate limited | Short shared caching was chosen over none | Phase 18 |
| G-81 | Usage is recorded in Database (`blob_usage`) and is not reported to Cloud billing or shown anywhere | Billing is Phase 16 | Phase 16 |
| G-82 | Quota is per bucket. There is no environment or organization total, and no plan limit | No plan policy yet | Phase 16 |
| G-83 | If cleanup cannot delete an abandoned upload's bytes, it does not try again: the transfer is already closed. Those bytes stay until removed by hand or by a bucket lifecycle rule | The store port has no listing | Cleanup lists a bucket's prefix, or the bucket gets a lifecycle rule |
| G-84 | The legacy storage engine and its routes (`/api/projects/.../storage`, `/storage/v1/object/public/...`, base64 JSON uploads) still exist beside canonical blobs, unhardened | Retiring them needs the unified frontend | Phase 17 |
| G-85 | `S3BlobStore` has run only against a local MinIO container, in a test CI skips; the scenario tests use an in-memory stand-in for the bucket | CI has no object store | With G-44 |
| G-86 | Final deletion of an environment does not remove its blobs (see G-09), and blob events are not in the organization log (see G-21) | Owning-service deletion and events are open across the platform | With G-09 and G-21 |
| G-87 | There is no range request, no conditional request, no object metadata or tags, no copy or move, and no listing by delimiter | Not needed for the proof gate | A need for them |

## Open: from Phase 12 (realtime, vectors, graph)

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-88 | A change event names the row and what happened; it carries no row values, old or new. A reader fetches the row with a query | Row images in the feed would copy customer data into a second place and need their own policy checks | A decision on row images |
| G-89 | Who is told about a change is decided from the policies and the owner column at the moment of the change. A reader who gains access later is not told about earlier changes, and one who loses access (not by a policy change) keeps being told about rows they owned at the time | The feed stores a visibility snapshot instead of re-evaluating policy at read time | A decision: snapshot or read-time evaluation |
| G-90 | The change stream is polled by Cloud once a second per open stream, and exists only for account sessions. There is no push, no broker, and no stream endpoint for app users, who must poll `rows.changes` themselves with a fresh assertion each time | The pull primitive came first | An app-facing stream with its own authentication, and a notification path that does not poll |
| G-91 | Reading the change feed is not audited or rate limited, and every reader re-scans the table's events from their cursor | A polled feed would otherwise flood the audit trail | Phase 18 |
| G-92 | Every schema or policy change resets every cursor on that table, even when it does not affect visibility | The table revision is the only visibility revision there is | A separate policy revision |
| G-93 | Rows changed before migration 0009 are not in the feed, and a table's capture trigger can be dropped by anyone with ownership of the table in PostgreSQL; nothing detects a missing trigger | The trigger is not part of the managed-constraint drift check | The drift check covers the capture trigger |
| G-94 | Vector search is exact: every point of a collection is scored on every query. There is no approximate index, so cost grows with collection size up to the 100,000-point limit | The points table holds vectors of every dimension in one column, which pgvector cannot index | Per-collection storage with an index, and a measured accuracy contract |
| G-95 | Vectors are stored in single precision; a value read back can differ from the one written in its last digits. Metadata filters are equality on top-level scalar values only | pgvector's `vector` type; simplest filter first | A need for more |
| G-96 | Large vector and graph work does not run as cancellable jobs, as the plan asks. A batch is at most 100 points; a walk is bounded by depth and size and by a ten-second statement limit | Bounded synchronous commands were enough for the proof gate | Bulk load and bulk walk as jobs |
| G-97 | A shortest-path search looks at no more than 5,000 newly reached nodes per level. In a graph wider than that it can answer "not found" when a path within the depth limit exists | Bounded work per request | The limit is reported in the answer, or the search becomes a job |
| G-98 | App users cannot use vectors or the graph, and neither has row-level or node-level policy: anyone with `data.read` in the environment reads all of it | Needs an ownership model for points, nodes and edges | With G-76 |
| G-99 | The legacy realtime (in-process websocket), vector and graph engines and their routes still exist beside the canonical ones, unhardened. Vector and graph limits are fixed constants, not plan quotas, and their usage is not metered | Retiring them needs the unified frontend; quotas are Phase 16 | Phases 16 and 17 |

## Open: from Phase 13 (functions and schedules)

Phase 13 met its proof gate, but section 16 of the backend plan asks for more
than was built. Each difference is an entry here.

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-100 | **A function is not isolated or limited.** It runs as a child process of the worker, as the worker's own user, with that user's files and network and no CPU, memory or disk limit. Only wall time and output size are bounded. Its environment holds only the lease's secrets and a few start-up variables, but it can read any file the worker can. A process the function starts itself is not killed with it | The same missing sandbox as builds (G-38); the plan requires CPU, memory, filesystem and egress policy | With G-38: a real isolation boundary, proven by a function that tries to leave it |
| G-101 | Schedules are fixed intervals in seconds. There is no cron expression, no IANA time zone, no daylight-saving rule, no configurable overlap or missed-run policy, no input and no dedicated credential, all of which the plan lists. Default chosen: skip on overlap, one run for any number of missed slots | The simplest schedule that proves one run per slot | Calendar schedules with a stated time-zone and DST contract |
| G-102 | There are no execution logs. Standard output and error are discarded, and a failure is one category with no message, so a failing function cannot be debugged from Cloud | Logs need redaction, bounds and retention (the plan's wording), as build logs have | Bounded, redacted, retained logs per execution |
| G-103 | A revision names its secrets, not versions of them. An execution gets whatever value is current when the worker fetches it, so rotating a secret changes what an old revision and a retry see. The plan asks for secret version references in the snapshot | Leases deliver the current version only | Leases can deliver a pinned version, or the choice to follow the current one is accepted |
| G-104 | Only an account's browser session can invoke a function. App users, service accounts and environment credentials cannot, there is no HTTP or event trigger, and there is no call that waits for the result. The plan asks for app and service principals through explicit grants | Each needs its own grant model | Invocation grants per principal kind |
| G-105 | Code is one ES module stored as text. There are no drafts, no packaging, no dependencies, no validation at deploy (a syntax error is found at the first run), no recorded runtime version, and no promotion of a revision between environments. The plan asks for each | The smallest deployable unit that proves immutability | A packaging step and a deployment snapshot that includes the runtime |
| G-106 | Inputs and outputs are stored unencrypted in Cloud's database and are never removed; nothing redacts an output, so a function that returns a secret makes it readable with `metadata.read`. Executions, revisions, events and idempotency records have no retention | Retention and redaction were not designed | A retention policy, and a decision on redacting outputs |
| G-107 | Function limits are fixed constants, not plan quotas, and execution time is not metered | Quotas and metering are Phase 16 | Phase 16 |
| G-108 | The legacy in-process `EdgeFunctionsEngine` in Carbon Database and its routes still exist, unhardened, beside this. The plan forbids `AsyncFunction` or `eval` in an HTTP process in production | Retiring it needs the unified frontend | Phase 17 |
| G-109 | Not proven: the `function-worker.ts` entry point has never run as its own process against a served Cloud (the use case and runner are tested through the in-process worker API); the sweeper's calls to `reconcile` and `tick` are not covered by a test; the real-process test has only run on Windows; a build lease presented to the function routes is refused by code that no test reaches; a scheduled slot skipped because a secret is gone is untested; invoking in a paused or archived environment is untested | Each needs a served deployment or another scenario | A deployed worker runs a function end to end, and the listed scenarios have tests |
| G-110 | An execution can run more than once: a worker that dies after the function had effects is replaced, and the function runs again from the start. Only lost workers are retried, at most three attempts, with no backoff; a function failure is never retried automatically and there is no dead-letter list | At-least-once on worker loss was the default chosen | A stated delivery guarantee and a retry policy per function |
| G-111 | The scheduler runs inside the lease sweeper, so a slot fires up to one sweep interval late and stops entirely if that process is down. A skipped slot is visible only as an event in the database, not through the API. Function events are not in the organization audit log (see G-21) | One background process so far; events are open across the platform | Monitoring of the sweeper, skipped slots in the API, and G-21 |
| G-112 | Functions, revisions and executions are stored in Cloud. The plan says Database remains the resource owner | Cloud already owns leases and secrets, and one transaction across both was needed to create an execution with its lease | A decision: keep them in Cloud, or move them behind signed Database requests |
| G-113 | A function cannot be deleted or renamed, a revision can never be removed (not even one deployed with a secret pasted into its code), and final deletion of an environment does not remove its functions (see G-09) | Immutability came first; deletion is open across the platform | A reviewed removal path for revisions, and G-09 |

## Open: from Phase 14 (Registry publishing and trust)

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-114 | **Operators are names, not accounts.** Review is a command-line tool beside the service; the operator is whatever name is typed, there is no operator sign-in, role or second approver, and the tool itself (`composition/review.ts`) has no test | Operator accounts and the operator boundary are Phase 16 | Phase 16: authenticated operators, and two-person approval for revocation and trust changes |
| G-115 | Registry's signing key is a seed in an environment variable, not a key in a KMS or HSM. The trust bundle is static configuration, so rotating a key means a redeploy. No root key ceremony is written down, and no rotation (new key active, old key retiring, then revoked) has been exercised in a deployment | No KMS or deployment was available; the bundle format and its checks came first | A signing key held in a KMS, a written root procedure, and a rotation drill (with G-01 and Phase 18) |
| G-117 | Inspection reads a library's header and nothing more. It does not prove the library loads, exports the plugin ABI, was built for the declared ABI version, or needs only the capabilities it declares. There is no malware scan, no check that a build is reproducible from source, and no publisher's own signature: only Registry signs | Each needs tooling that does not exist yet (an ABI reader, a scanner, a build service) | An ABI and capability check against the binary, at least |
| G-118 | The legacy Registry API, its tables, its marketplace page and its ephemeral-key signing still run beside this. Its pre-seeded standard-library packages are not real versioned builds and are not labelled as fixtures, which the plan requires | Retiring it needs the CLI and the unified frontend | Phases 15 and 17 |
| G-119 | Every published package is public. Any member with `release.publish` in any environment of an organization can publish under any of that organization's publishers; there are no per-publisher members or grants. A publisher cannot be renamed, transferred or released, and although a publisher has a `suspended` state, nothing sets it. The loader's local name is the package name; there is no explicit mapping | The simplest ownership model that proves namespace authority | Publisher membership, private packages and a suspension operation |
| G-120 | There is no deprecation state, no search or index of all packages, no download count, and no rate limit on the public endpoints or on upload attempts. Archives are held in memory whole on upload, review and download (up to 64 MiB each) | Not needed for the proof gate | Streaming transfer, rate limits (Phase 18) and a package index |
| G-121 | A crash between storing an archive and committing can leave an object nobody refers to, under `quarantine/` or `packages/`; nothing sweeps for them. A revoked version's bytes are kept forever. A reservation that was never used is closed only when the same version is submitted again; otherwise it stays `awaiting_upload` (it stops counting toward the limit when it expires). Final deletion of an organization does not remove its publishers (see G-09) | No sweeper was built | A sweep of unreferenced objects and stale reservations, and G-09 |
| G-122 | Not proven: `S3RegistryArchiveStore` against a real bucket; Registry's environment wiring (`publishingFromEnv`) and the review tool as processes; writes refused in a paused environment; a browser session that is no longer fresh at Registry's live check; publishing through the CLI and service-account assertion exchange (only `namespace.get` is tested that way); real Linux and macOS libraries (headers are hand-made in tests); a plugin actually built by the Zig toolchain, packed and published | Each needs a deployment, another credential path, or a real build | Those scenarios have tests, and one real plugin goes from build to install |
| G-123 | Registry's package events are in Registry's own table, not the organization audit log (see G-21). A publisher learns of a rejection or revocation only by reading the version; nothing notifies them | Owning-service events are open across the platform | G-21, and a notification |
| G-124 | The upload address is disclosed once. If that response is lost, the publisher must withdraw the reservation and submit again with a new command | Disclosing a credential a second time was the worse default | An explicit "new upload address" command |
| G-125 | An operator's rejection reason and a publisher's yank reason are free text shown to others; nothing limits what is written beyond length. A revoked version's reason is public | No moderation model | A decision on reason categories |

## Open: from Phase 15 (plugin consumption and the CLI)

Phase 15 built resolution, locking, verification and installation. Section 18
of the backend plan asks for more; each difference is an entry here.

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-126 | **An installed Registry package cannot run in an app.** Its files are verified and written under `carbon/plugins/registry/`, but `carbon build` does not stage them into the app, and the runtime loader (`plugin/trust`, Rust) accepts only the local developer signing scheme, not Registry's statements | Needs loader and build changes in Rust and Zig that were out of reach of this phase | A Registry package is installed, built into an app and loaded, with the loader checking Registry's statement |
| G-127 | Cloud has no project plugin API. The plan's flow is not built: desired state held in Cloud, resolution from an immutable commit, capability approval recorded in Cloud, and the lock written through a source proposal by the repository integration. Everything is the CLI and two files in the project | The repository provider cannot read a file at a commit, and no real GitHub was available to prove a proposal (G-02 is the same kind of gap) | Cloud resolves from a commit and opens a proposal carrying the lock, proven against a real repository |
| G-128 | The other CLI workflows the plan lists are not built: organizations, projects and environments; builds, logs and artifacts; releases and channels. Cloud has no routes that accept a device credential for them. `carbon plugin publish` still posts to the legacy Registry API with a `cc_` token, and `carbon plugin add registry:<name>` still trusts a key the Registry endpoint returns, which the plan forbids | Each needs new Cloud routes for device credentials; the legacy paths stay while the legacy Registry does (G-118) | Device-credential routes in Cloud, the commands over them, and the legacy plugin paths removed |
| G-129 | No root key ships with the CLI. Each project pins its own in `carbon/registry.json`, taken from wherever the developer got it. A project has one Registry: no mirrors, no proxy, no second registry. Changing the root is a hand edit with no ceremony | No production root key exists (G-115) | A production root, shipped with the CLI and overridable per project |
| G-130 | A lock entry holds only the targets some machine has resolved. A machine with a new target must run `update`, which writes the lock, so a build for another platform cannot be frozen until someone on that platform has locked. There is no command to lock every target at once. Ranges are exact, `^`, `~` and `*` only | Resolution is per host | Locking for a list of targets in one command |
| G-131 | Not proven: the real `carbon` binary end to end against a served Registry (the command tests use an in-memory Registry, and the real-Registry test drives the use cases below the command line); timeouts and partial responses over a real network (only a stopped server and a 503 are tested); the directory swap on Linux and macOS (every run was on Windows); two commands at once in one project (nothing guards it); a process killed mid-write (failures are injected exceptions, not kills) | Each needs another machine, a real network fault, or a kill harness | Those scenarios have tests |
| G-132 | Temporary `.staging` and `.previous` directories left by a hard kill are ignored but never cleaned up. The cache is never evicted and has no size limit | No sweeper | A cleanup pass and a cache limit |
| G-133 | Capability approval is a record in the lock, per package, not per target. Nothing at runtime holds a plugin to the capabilities that were approved, and nothing checks that the binary needs only what its manifest declares (see G-117) | Enforcement belongs to the loader | With G-126 and G-117 |
| G-134 | `audit` runs only when someone runs it. A revoked package already installed stays installed and is not reported by `build` or `run`. An offline install cannot learn of a revocation at all | No hook into build yet (G-126) | Build refuses a revoked package, at least when online |

## Open: from Phase 16 (billing, quotas, operators, deletion gates)

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-135 | **Backup and restore are not built.** There are no recovery points, no record of what a backup covers and excludes, no restore into a new or replaceable environment, and no retention or expiry of recovery points. Table exports (Phase 10) are not backups. This is half of the phase's proof gate | It is a feature the size of a phase, across Cloud, Database and object storage | Recovery points with recorded coverage, and a restore proven into a fresh environment |
| G-136 | Nothing has run against the real payment provider. Event shapes are from its documentation, signatures are checked against Cloud's own computation of the documented scheme, checkout goes through a stand-in, and `StripeCheckoutProvider` returning the session identifier is untested | No provider account was available | A checkout, a failed payment and a cancellation in the provider's test mode drive the same states |
| G-137 | A subscription that is late on payment keeps its plan until the provider ends it, with no limit of Cloud's own. There is one paid plan and no plan change, proration, trial, tax or seat handling. Cloud offers no way to cancel or resume: that is done at the provider. Going back to free does not check what the organization already uses | Default chosen: follow the provider | A grace limit, a plan-change path, and a link to the provider's customer portal |
| G-138 | Unknown outcomes are kept, not resolved. An event Cloud cannot tie to an organization is stored and can be listed by code that no route or tool calls. A subscription event that arrives before its checkout's completion is unmatched and is not replayed afterwards. Nothing reconciles Cloud's picture against the provider's. A checkout nobody finishes leaves the organization `checkout_pending` until another is started | The inbox and projection came first | An operator view of unmatched events, replay after a late match, and periodic reconciliation with the provider |
| G-139 | Only build minutes and function invocations are metered and limited by plan. Storage, egress, database size, vectors and Registry are not: their limits are still fixed constants (G-99), and so are the other function limits (G-107) | Each needs its own source of truth for usage in the owning service | Those meters, each with a unique source key |
| G-140 | A budget warning is an event in the organization's log and nothing more: nobody is emailed. It fires once per month when the line is crossed, with no earlier thresholds. Warn-mode budgets are not applied to builds, only caps are | No billing notifications exist | Notification of warnings and of a failed payment |
| G-141 | Operators authenticate with a bearer credential issued from the command line. There is no operator sign-in, second factor, single sign-on, network restriction or rate limit, and creating an operator is not itself in the operator record. Two-person approval covers early deletion only, not suspension, holds or trust rotation. Registry review still takes a typed name (G-114) | The boundary and the record came first | Operator sign-in with a second factor, operator administration in the record, and Registry review under the same accounts |
| G-142 | A legal hold stops final deletion and nothing else. It does not stop the customer from deleting tables, rows, blobs or packages in the ordinary way, and it does not stop a deletion from being scheduled. There is no customer-facing preview of what blocks a deletion or what is kept, and an owner is not told why a deletion is waiting. A chargeable subscription blocks the organization's final deletion but not a project's or an environment's | Preserving live data needs holds in every owning service | Holds enforced by Database, Registry and storage, and a deletion preview for owners |
| G-143 | Suspension blocks customer changes as before, but charged work already running continues, schedules of a suspended organization are not paused by suspension itself, and the subscription is not paused | Suspension semantics were not revisited | A decision on what suspension stops |
| G-144 | Migration promotion between environments and drift detection (the first item of the plan's section 19.3) are not built (see G-65) | Not reached | With G-65 |
| G-145 | Not proven: the entrypoint's routing of `/billing/v1/` and `/operator/v1/`, `billingFromEnv`, and the `operator-admin` tool as processes; webhook deliveries racing across more than one Cloud process (the test races them inside one). The legacy billing use cases and routes still exist and write the plan table directly, beside the new projection | Each needs a deployment; the legacy routes need the frontend moved first | A served deployment handles a provider event, and the legacy billing path is removed (Phase 17) |
| G-146 | Build minutes are written to two ledgers, the older `usage_records` and the shared `usage_events`, and build admission still reads the older one. A function execution is charged when it ran, whether it succeeded or not. Usage events are never rolled up or expired | The build path was left as proven in Phase 7 | One ledger, and a retention rule |

## Open: from Phase 17 (the console against the live service)

Phase 17 connected one part of the console. The proof gate asks for every
walkthrough of the frontend plan; this is the first.

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-147 | **Most of the console is not connected to the live service.** Accounts, organizations, members, invitations, projects and environments are. Credentials and configuration, builds and releases, tables and data, application authentication, storage, vectors, graph, realtime, functions, Registry, billing and the operator area are not: their routes show a notice. The backend for most of them exists (Phases 7 to 16); the browser adapters do not. The Activity page is gated too, although the audit list is connected and shown on overviews | One vertical slice was done in the phase's first pass | Each remaining slice has live adapters and its walkthrough against real services |
| G-148 | Inside the connected part, these do nothing against the live service: GitHub sign-in and linking, recovery by code, notifications, deleting an account, ownership transfer, billing contact, declining an invitation, the list of invitations an account received, and environment provisioning and policy. **A member's project assignments and extra grants are not sent:** the form offers them and the adapter saves the role only. A project's "start with" choice maps loosely to its owning services, the initial environment kind is ignored, and pausing a production environment asks for the environment's name where the API wants the project's slug | The mock's contract and the live API differ in these places, and each needs a decision about which side moves | The contract or the API is changed so they agree, per item |
| G-149 | Lists against the live service have no total, and no filtering or sorting by name on the server. The console filters the page that came back and reports that page's length as the total, so a filter can show an empty page while matches exist on a later one. Page sizes are still the small ones chosen to demonstrate paging in the mock | The live list endpoints page by cursor only | Server-side filtering, or a console that does not offer a filter it cannot honour |
| G-150 | Nothing is live on the page. The event stream is not connected, so a page shows what it loaded until it is reloaded or a command on that page refreshes it. The operation panel is hidden. The links in the email-change and recent-sign-in emails (`/account/email/verify`, `/auth/fresh`) are not handled by the console, so those two flows cannot be finished in it | The stream and those two routes were outside the first slice | The event stream adapter, and the two routes |
| G-151 | **Not proven in a real browser.** Tests render pages with a test renderer and call the adapters through Cloud's handler in one process. No test drives a browser, so `__Host-` cookies, `SameSite`, the content security policy, the back-forward cache and following a link from a real email are unproven. CI does not run the Vite build; a test that walks the import graph stands in for the build's own check. Serving the console from Cloud is tested at the handler, not through the entrypoint. The bundle still ships the code and mock-era wording of pages that are not connected, although they are never rendered | No browser automation exists in the repository | A browser test of the walkthrough against a served Cloud, the build in CI, and unconnected pages left out of the bundle |
| G-152 | The console is functional structure. It has no visual design, no design system, no accessibility review and no translation. The frontend plan puts visual design second; it is still owed | Out of scope of this pass | A design pass |
| G-153 | The mock composition is still the default (`browser.tsx`, `dev:mock`), and Cloud's root page without `CARBON_CONSOLE_DIR` still points at it. The legacy `/v1/*` API and its dashboard remnants remain | Removing them needs the whole console connected | With G-147 |

## Open: verification

| # | Gap | Why open | Closes when |
|---|---|---|---|
| G-50 | **CI does not run the PostgreSQL-backed tests.** The workflow has no database, so `account_auth_test` and the other integration suites skip their database scenarios there and pass in about two seconds. Every "CI green" in this log means typechecks, lint, unit tests, the contract and conformance tests and the Rust build passed. The database scenarios have only ever been run on the development machine | CI runs on Windows runners, where service containers are not available | CI starts PostgreSQL (and MinIO, G-44) and sets the `CARBON_*_TEST_DATABASE_URL` variables |

## Open: local environment

| # | Gap | Notes |
|---|---|---|
| G-23 | The uncommitted `defs.bzl` change runs `cargo sweep` after every Cargo call, which breaks a local parallel `bazel test //...` | CI is unaffected. Reverting it needs the owner's approval |
| G-24 | `products/carbon/~/` is a stray 580 MB Cargo-home copy that fails the local boundaries test | Gitignored, so CI is unaffected. Deleting it needs the owner's approval |
| G-25 | `products/carbon-website` has an unfinished redesign that is deliberately uncommitted | See `.local/notes/git-cleanup-2026-09-05.md` |
| G-26 | A full local `bazel test //...` has not passed since before Phase 2 | Blocked by G-23 and G-24; CI runs it on every push and is green |

## Closed

| Gap | From | Closed by |
|---|---|---|
| G-116: nothing installed from the canonical Registry | Phase 14 | Phase 15: `carbon plugin registry` resolves, verifies against a pinned root, locks and installs, and remembers the trust-bundle sequence. What remains is split out: loading (G-126) and the legacy CLI paths (G-128) |
| G-10: Registry served one canonical request, `namespace.get` | Phase 2 | Phase 14: eight canonical commands for publishers and versions, under the same signed, request-bound, live-checked authority |
| Three updaters decided differently: the standalone one bucketed rollouts without the version, accepted unsigned manifests and ignored `min_version`; the runtime one ignored `min_version` and would install an older version | Inherited | Phase 9: one decision function per language, all held to the shared conformance fixture |
| The Rust updater's tests never ran in CI | Inherited | Phase 9: `//solutions/capabilities/distribution/updating:rust_updater_test` |
| G-27: Cloud did not verify declared artifacts | Phase 7 | Phase 8: every declared object is read back and its size and SHA-256 compared before success; keys are confined to the build and attempt |
| G-31: secret values were not removed from build logs | Phase 7 | Phase 8: the worker redacts lease secrets and its own credentials before sending (encoded forms remain open as G-46) |
| G-35: no worker runtime spoke the canonical build protocol | Phase 7 | Phase 8: `RunLeasedBuildUseCase` and `build-worker.ts` (real packaging remains open as G-36) |
| Worker leases had no production caller | Phase 4 | Phase 7: creating a build grants its lease in the same transaction |
| HTTP route files lived under `presentation/http/`, against the rule that `presentation/` is UI only | Inherited, and continued in Phases 4 and 6 | Moved to `infrastructure/http/` in all three services, 2026-10-10 |
| Personal credentials could not be exchanged for assertions | Phase 3 | `7502ee9` |
| No CLI command called Registry | Phase 2 | `7502ee9` |
| Worker enrollment was not rate limited | Phase 4 | `7502ee9` |
| Events before the organization log were not in it | Phase 5 | `7502ee9`, migration 0025 |
| The app API could not be called from a browser | Phase 6 | `7502ee9` |
| Automation credentials could write to a paused environment | Phase 5 | `7502ee9` |
| `cs_`/`ce_` credentials were accepted on an environment scheduled for deletion | Found in Phase 5 | `431a672` |
