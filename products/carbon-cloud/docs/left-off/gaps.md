# Gap ledger

Every item the platform work has left not done, not proven, or deferred. Add an
entry in the same commit that creates the gap, and move it to "Closed" in the
commit that closes it. A phase is not reported as finished until its gaps are
here.

Each entry says what is missing, where it came from, why it is open, and what
would close it.

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
| G-27 | Cloud does not verify that a declared artifact exists in object storage or matches its size and SHA-256 before accepting success | Needs object-store access from Cloud and a real upload path | Phase 8 |
| G-28 | A build's input is a commit, targets, secret names and platform; it is not a full snapshot of configuration, toolchain and dependency locks | Those are produced by real execution | Phase 8 |
| G-29 | The commit SHA is supplied by the caller; a build is not created from a branch or tag through the repository integration, and `repositoryId` is optional | Resolution exists (`RepositoryCommitResolve`) but is not chained into build creation | Phase 8 |
| G-30 | There is no dedicated build permission; creating a build needs `release.publish` | Adding one changes the permission vocabulary and role presets | Needs a decision |
| G-31 | Cloud removes only credentials shaped like its own from logs; it does not know secret values and cannot remove them | By design Cloud keeps no plaintext secrets; the worker must redact what it was given | Phase 8 (worker runtime) |
| G-32 | Build logs are read by polling `?after=N`; they are not on the event stream | The stream carries events, not log text | Phase 17 decides the UI need |
| G-33 | The reservation is a fixed 30 minutes, the deadline equals it, and attempts are fixed at three | No per-plan or per-build policy yet | Phase 16 (quotas) |
| G-34 | Quota reads the legacy `org_plans` and `usage_records` tables, whose organization column is text | Billing is rebuilt in Phase 16 | Phase 16 |
| G-35 | No worker runtime speaks the canonical build protocol; `solutions/capabilities/cloud/worker` still implements the legacy queue | Real execution is the next phase | Phase 8 |

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
| Worker leases had no production caller | Phase 4 | Phase 7: creating a build grants its lease in the same transaction |
| HTTP route files lived under `presentation/http/`, against the rule that `presentation/` is UI only | Inherited, and continued in Phases 4 and 6 | Moved to `infrastructure/http/` in all three services, 2026-10-10 |
| Personal credentials could not be exchanged for assertions | Phase 3 | `7502ee9` |
| No CLI command called Registry | Phase 2 | `7502ee9` |
| Worker enrollment was not rate limited | Phase 4 | `7502ee9` |
| Events before the organization log were not in it | Phase 5 | `7502ee9`, migration 0025 |
| The app API could not be called from a browser | Phase 6 | `7502ee9` |
| Automation credentials could write to a paused environment | Phase 5 | `7502ee9` |
| `cs_`/`ce_` credentials were accepted on an environment scheduled for deletion | Found in Phase 5 | `431a672` |
