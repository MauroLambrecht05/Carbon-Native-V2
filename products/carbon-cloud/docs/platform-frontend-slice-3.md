# Slice 3: project configuration and credentials

Implemented against the Slice 3 boundary in section 22.2, the project onboarding
stories in section 7.4, and the credential and activity stories in section 17 of
the [platform plan](platform-frontend-plan.md). It builds on the completed
[Slice 1 foundation](platform-frontend-slice-1.md) and
[Slice 2 platform shell](platform-frontend-slice-2.md). Every workflow remains a
local mock; no repository provider, Carbon service, native CLI, or external API
is contacted.

## Implemented scope

| Area | Working behavior |
| --- | --- |
| Repository connections | Organization administrators connect, reconnect, and explicitly disconnect GitHub installation fixtures. Provider scopes, accessible repositories, status, revisions, and dependent project IDs are visible. Disconnecting an in-use installation requires exact confirmation and marks dependent configurations disconnected. |
| Project repository | Project configurators select an installation, repository, branch, application root, and push/pull-request triggers. The adapter produces ready, missing-manifest, conflict, and disconnected states. A ready configuration creates a local proposal that can be explicitly applied; no checkout or pull request is modified. |
| Project setup | Project overview computes identity/environment, repository, and API-access tasks from normalized state. First table, build, and release tasks identify their later owning slices and build remains blocked until repository setup is ready. |
| General and API settings | Project name/slug changes use revision checks and stable IDs. Environment API pages separate public client identifiers/endpoints from privileged server credentials and do not claim an unimplemented `@carbon/*` SDK. |
| Environment credentials | Create narrow backend/CI credentials with bounded expiry and action scopes, rotate immediately or with a 1/24-hour overlap, and revoke. The actor cannot grant data or release access they do not hold. Prefix, expiry, last use, dependencies, and status remain visible; the fake credential value is returned only once. |
| Secrets | Create and replace values while returning only metadata. Values are excluded from persistence, DTOs, activity, and idempotency data; a redacted fingerprint distinguishes retries. Removal previews bindings and is refused until every dependent resource is rebound or disabled. |
| Organization automation | Organization-owned service accounts receive project/environment grants and independently expiring credentials. Disabling the account revokes all issued credentials without depending on the creator's session. |
| Personal automation | Account holders create and revoke expiring personal tokens within their current access. Active CLI/device grants show scopes, last use, and affected projects; revocation remains separate from application-user sessions. |
| Device authorization | `/authorize-cli` validates a device code, shows the requesting client, device, organization, expiry, and exact scopes, then approves or denies once. Wrong, expired, reused, or unauthorized requests are explicit failures. |
| Activity | Organization and project activity routes filter persisted audit records by actor, action, result, project, and environment through URL state. Configuration mutations and known-scope refusals produce safe records and events without values or command payloads. |

## Architecture and safety properties

`configuration-contracts.ts` adds the Slice 3 browser port without changing the
mock-only composition boundary. `configuration-state.ts` is an additive schema-v1
extension, so completed Slice 1/2 workspaces are retained and missing project
records are initialized lazily. `configuration-services.ts` uses the same active
principal resolution, scope ownership checks, serialized transactions,
idempotency keys, revisions, audit/events, clock reconciliation, cache
invalidation, and copied DTO boundary as the earlier slices.

Raw credential values exist only in the successful command receipt used by the
one-time UI. Raw secret inputs are validated and discarded. Stored state contains
prefixes or metadata plus a local non-reversible retry fingerprint; audit records
say `redacted`. Browser and desktop clients receive public environment
configuration and are explicitly warned not to embed server credentials.

The fixture workspace includes connected and attention-needed installations,
ready/missing/conflicting project configurations, an active environment
credential with a dependent CI workflow, a bound signing-reference secret, an
organization service account, an active CLI grant, and pending device code
`CARBON-7F3K`. These are demonstration values and production policy is not
inferred from their expiry periods or scopes.

## Verification

The focused Slice 3 checks cover repository/checklist transitions, one-time
credential results, metadata-only secret storage, bound-secret refusal, one-use
device authorization, and activity filters. Browser TypeScript, all 32 focused
browser tests (33 total), and the mock production build pass. Vite retains the existing
non-blocking warnings about ignored TanStack Query `use client` directives.

At the Slice 3 handoff, builds, signing, releases and channels were capability
placeholders. They are now implemented in [Slice 4](platform-frontend-slice-4.md).
The seeded signing-secret binding now connects to the project's signing metadata.
