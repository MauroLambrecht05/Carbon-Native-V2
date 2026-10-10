# Slice 4: Windows build and release flow

Implemented against sections 8–9 and the Slice 4 boundary in section 22.2 of
the [platform plan](platform-frontend-plan.md), extending the completed Slice
1–3 contracts, adapters, transactions, routing, permissions and query cache.
Slice 5 is now documented in [its handoff](platform-frontend-slice-5.md). This frontend still contacts no Carbon backend,
repository provider, worker, signing service, native runtime or installed PC.

## Routes and stories

| Routes | Requirements and behavior |
| --- | --- |
| Project `/builds`, `/builds/:buildId` | BUILD-01/02/05–10: preflight, manual/provider triggers, provider-delivery deduplication, immutable commit/configuration/environment/secret-version/plugin inputs, queue/run durations, seven timed stages, attempts and fenced leases, streamed redacted logs, immediate queued cancellation and acknowledged running cancellation, original-input or explicit latest-source retries. Detail tabs are URL state. |
| Project `/settings/repository`, `/settings/build` | BUILD-03/04/11: reuse existing installations, proposals and conflict states; version Windows format/profile/toolchain/timeout/attempt/pool overrides; invalidate the next build's scoped cache without changing prior inputs/artifacts. Known historical commits retain their original source manifest. |
| Build Artifacts tab | BUILD-09/10/12: separate `nsis`/`wix` installer format from `x86_64-pc-windows-msvc`; expose inert full-update payload separately from installers. Show exact fixture size/digest, signature/readiness, expiry, references, removal tombstones and authorized downloads. Published/withdrawn history pins its artifact retention. |
| Organization `/workers` | Registration, one-time fake enrollment credential, supported formats/toolchain, heartbeat, task, capacity, pause, drain, resume, rotate, revoke and offline removal. Revocation prevents new tasks and expires an active lease. Managed capacity is aggregate customer metadata; managed-fleet operator controls remain Slice 9. |
| Project `/settings/signing` | BUILD-10, REL-09/10: certificate reference/public identity/expiry, explicit not-configured/signed/invalid/expired/unknown states, update public-key rotation with simulated cross-signing and overlap, affected releases and revocation. Bound secret values never enter DTOs. |
| Project `/releases`, `/releases/:releaseId` | REL-01/02/07/11: create/edit/delete drafts from successful builds; binary version consistency, unique versions including withdrawn history, artifact selection, client/migration declarations, publication preflight, staged validate/sign/upload/pointer commit. Failed publication retains the old channel pointer; retry keeps its operation identity. Withdrawal needs reason, replacement plan and exact confirmation, retains history, and pauses affected channels. |
| Project `/channels`, `/channels/:channelId` | REL-03–08: stable/beta plus custom channels, version-checked promotion, 0–100 integer rollout, stable cohort, eligibility preview, pause/resume, rollback to previous signed compatible release, history and separately labelled delivery evidence. Rollback checks both environments and both migration declarations. |
| Project overview, activity, account notifications, operations | Build/release setup tasks derive from shared state; commands and transitions emit safe audit/events; completion notifications link to resources; operations reconcile after reload; usage meters each execution attempt once and releases its reservation at completion. |

## Contract and adapter boundary

`presentation/framework/services/delivery-contracts.ts` defines the typed
`BrowserServices.delivery` port. It groups build/settings/preflight/log/artifact,
worker/capacity, signing, release and channel methods by domain. Inputs and DTOs
use the existing `Scope`, `RequestContext`, `Result`, `CommandOptions`, `Page`,
`Action` and operation conventions. No transport `Response` objects or backend
URLs are returned to these pages. Downloads return filename, content type and
local bytes; the view only creates and revokes a browser download handle.

`delivery-state.ts` adds normalized schema-v1 collections; completed Slice 1–3
workspaces are preserved. `delivery-services.ts` executes through the existing
serialized coordinator and rollback boundary. `delivery-engine.ts` reconciles
persisted deadlines in chronological order across jobs, preserving capacity,
attempt ownership and one-time metering when the clock advances or a tab reloads.
Only the active attempt's task-scoped lease can advance or accept artifacts;
expired attempt records remain in history. Worker execution is never performed.

Build and publication operations also appear through the existing operations
port. Their generic cancel/retry actions explain that their resource workflow
must be used; this prevents bypassing author checks, production confirmation,
immutable retry selection or channel revision review.

Every scoped query, mutation, download and log subscription resolves the trusted
dashboard principal and tenant ancestry. Mutation receipt replay rechecks current
permissions. Foreign resources return not-found; known unauthorized actions
return forbidden. Resource revision mismatches return conflicts; same idempotency
key with changed input conflicts; provider delivery IDs independently deduplicate
events. One-time worker credential values are excluded from persisted receipts.
Logs and audit contain no secret inputs. Scoped event invalidation and session
revocation reuse Slice 1–3 behavior.

Permissions add `build.cancel.any` (Owner/Admin or explicitly granted Developer)
and `signing.manage` (Owner or explicitly granted Admin). Build mutation uses
the selected environment's resource permission and production policy. Publishing
and channel changes require release permission for the intended environment;
stable and production actions identify that environment in confirmation.
Confirmation does not grant authority. Draft operations use configuration
permission, and artifact/worker administration requires organization management.

## Mock walkthrough and defaults

Start `bun run --cwd products/carbon-cloud dev:mock`, select the Owner fixture,
and open Acme North / Notes. Its repository and signing reference are ready.

1. Open Builds, review development/main with NSIS and/or WiX, then queue the
   reviewed inputs. Let the clock run or advance it by 20 seconds. Inspect the
   seven stages, lease/attempt, logs, inputs and three artifacts for both formats.
   Download inert fixture text; it is never an installer executable.
2. Create a draft from that successful build and publish beta. Advance six
   seconds, inspect the manifest and channel, widen rollout, pause/resume, then
   promote the same release to stable with the development environment ID as
   confirmation. The data environment stays development.
3. In Mock tools, simulate a new source manifest version (for example `1.1.0`),
   build again and draft the matching version. Arm `publish_failure` before
   publication; the previous pointer remains intact. Select `success`, review
   the current channel revision, and retry. Promote it to stable, roll back to
   the previous compatible version, or withdraw with a reason/replacement plan.
4. Queue and immediately cancel work while the clock is paused. For running
   cancellation, advance three seconds first, cancel and advance another second.
   Select `build_failure`, `timeout`, `lease_expiry` or `lease_exhaustion` to inspect
   failures, one replacement attempt or exhausted retry policy. Switch the
   scenario back to success before a manual retry. Original retry preserves the
   entire input snapshot; latest retry is an explicit separate command.
5. Use the other outcome controls for quota/capacity, stale refs, dependency
   trust/compatibility, signing validity/expiry/unknown, and lost responses.
   Lost-response recovery resubmits the unchanged form with its existing key or
   locates the committed resource in history. Mock failure controls do not cause
   feature components to branch on mock mode.
6. Register an organization worker, advance one second, select the organization
   pool in build settings, and queue work. Pause stops new claims; drain finishes
   existing work then goes offline. Rotation/revocation are distinct from drain.
   Offline removal refuses an active task. Credentials are one-time fake values.
7. Mock tools can set channel evidence to not-reported, simulated, offline or
   stale. Simulated population is explicitly 1,000 fixture installations, with a
   timestamp; it becomes stale after five mock minutes. Unknown population never
   becomes zero. These observations are not live delivery acknowledgements.

Demonstration defaults: two managed Windows slots, one task per organization
worker, 500 mock organization build minutes, up to three attempts, 1–60 minute
execution limits, 30-day temporary artifact retention and 1–90 day key overlap.
Usage reserves the maximum attempt budget and meters started attempts in rounded
minutes once. These are simulation settings, not commercial or legal policy.
Fixture digests are visibly prefixed `fixture-sha256`; no real cryptographic
signature, Windows certificate verification or cross-signature is claimed.

The simulated `carbon-polling-v1` contract supports full-update payload discovery,
rollout/pause/withdrawal metadata and key-overlap records. Installer-only drafts
cannot publish to an update channel. Actual runtime interoperability remains a
backend/client integration dependency; forced execution, restarts, recall, live
telemetry and automatic installed-client downgrade are unavailable. Data schema
and migration execution, dependency management, billing UI and managed operator
allocation remain their later slices.

## Focused review and verification

The Slice 4 review covered BUILD-01–12, worker lifecycle and REL-01–11. It corrected
retention of published assets, current authorization on receipt replay, original
source metadata on immutable retries, worker lease/capacity accounting, publication
revision conflicts and explicit delivery observation states.

Verification on 2026-09-06: browser TypeScript and mock production build pass.
The four existing configuration regression checks pass. A temporary adapter smoke
walkthrough exercised build success/download, draft/publication, publication
failure/retry, promotion/rollout/pause/resume/rollback/withdrawal, provider
deduplication, queued/running cancellation, lease replacement/exhaustion,
immutable retry, lost-response recovery, tenant/author denial, revoked permission
on replay, worker drain, metering, retained versus expired assets and reload.
The temporary script was removed; the test suite was not expanded. No visual
browser walkthrough or real Windows/client execution is claimed. Vite retains
the existing non-blocking TanStack `use client` directive warnings.

Real integration belongs to BE-05/06, with trusted identity/catalog enforcement
in BE-01/02/03, durable operations/audit in BE-11 and authoritative metering in
BE-12. Implement isolated Windows workers, durable redacted logs/artifact storage,
lease fencing, actual digest/signature verification, scoped short-lived download
authorization, immutable manifest publication and supported client compatibility
before replacing this mock port. No new backend endpoint or HTTP fallback was added.
