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
| G-10 | Registry serves one canonical request, `namespace.get` | Phase 2 | Phase 14 |
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
