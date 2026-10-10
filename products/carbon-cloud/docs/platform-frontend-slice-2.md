# Slice 2: identity and platform shell

Implemented against section 7 and the Slice 2 boundary in section 22.2 of the
[platform plan](platform-frontend-plan.md). Builds on the completed
[Slice 1 foundation](platform-frontend-slice-1.md). All behavior is mock-only;
no backend identity, provider, email or provisioning service is contacted.

## Implemented scope

| Requirement | Working behavior |
| --- | --- |
| ID-01/02 | Registration records mock terms and pending verification; email or linked GitHub proof establishes a dashboard session. Public requests return a generic receipt without a usable token. Invalid, expired, superseded and reused challenges fail. Safe return paths retain invitations and are checked by the existing route/scope guards. |
| ID-03 | Minimal invitation preview while signed out; authentication retains the route; accept/decline requires the matching verified email. |
| ID-04 | Profile name and local avatar initials/emoji; email replacement occurs only after verification; conflicting identity links fail. Avatar is local text, so rendering cannot issue a remote image request. |
| ID-05/06 | Verified MFA enrollment, one-time recovery-code display and replacement, disable checks, recovery through email or a consumed recovery code. Failed recovery creates a pending mock support case and never grants access. |
| ID-07/08/09 | Session inventory and revocation, linked provider proof, final sign-in method protection, sign-out, account deletion blocked by sole ownership. Successful deletion revokes memberships/sessions and retains a local audit tombstone. |
| ORG-01/02 | Available namespaces, Owner membership, default Free entitlement; canonical organization/project/environment navigation and old-scope cache removal. |
| ORG-03/04/05 | Paginated invitations/members, rotating resends, cancellation/expiry, role changes, project assignments, scoped grants, immediate revocation and leave. Owner changes use transfer; personal grants clear on removal. Organization-owned service accounts remain organization-owned. |
| ORG-06/07 | Freshly authenticated ownership proposal and recipient acceptance; prior owner receives the proposed lesser role. Billing contact is distinct from identity email and requires Owner/Billing permission. |
| PROJ-01/02/03/05 | Idempotent project creation with data, builds or both; development default, optional staging/production. Canonical IDs are allocated once. Isolated Cloud/Database/Auth/Functions bindings provision in independent stages. Partial failures retain completed stages and retry the same operation. A builds-only project can enable other bindings later. |
| Environment management | Rename and production-confirmation policy, explicit pause/resume with active-operation blockers. Paused environments refuse new resource mutations. Existing bindings and published availability are retained. |
| Account/security shell | Account navigation, organization MFA policy, effective permissions, session metadata, notification inbox/read state/preferences and resource links. |

At the Slice 2 handoff, repository connection, project general settings, setup
checklists, API credentials/secrets, CLI authorization/tokens and activity pages
were placeholders. They are now implemented in
[Slice 3](platform-frontend-slice-3.md). Data/app-user administration,
builds/releases and function execution also remain in their owning slices.
Organization/project/environment deletion inventories and retention workflows
remain Slice 9. Environment creation copies neither customer data nor secrets;
schema/configuration copying requires the later resource adapters.

## Architecture and contracts

- `presentation/framework/services/identity-contracts.ts` defines typed identity
  and platform ports. Discriminated command inputs, `Result` errors, revision
  conflicts and idempotency extend Slice 1 conventions. UI modules remain under
  `presentation/features/identity`; only development tooling can read challenges
  or mock authenticator codes.
- `identity-state.ts` adds normalized identity collections to the existing
  schema-v1 workspace. This is an additive extension: existing Slice 1 accounts,
  tenants, sessions, operations and bindings are preserved. Incompatible base
  schemas still require the existing explicit reset flow.
- `identity-services.ts` and `platform-services.ts` execute through the same
  serialized transaction coordinator, rollback boundary and post-commit
  notifications. They resolve the principal from trusted session state, never a
  supplied role. Material account changes have account audit metadata; scoped
  changes/refusals use the existing scoped audit/event collections.
- Existing `environment.provision` operations share the scheduler, cancellation,
  progress panel, reconciliation on reload and retry contract. The mock control
  can fail the next provisioning after its first stage. Service bindings remain
  metadata: successful provisioning does not claim that later resource UIs or
  any backend are implemented.
- Permissions distinguish organization administration, project creation,
  resource configuration and customer data. Grants cannot escape assignments,
  tenant ancestry, recipient role restrictions or the delegating actor's
  capabilities. MFA policy also checks the active session's MFA proof.
- Account changes invalidate account queries across tabs. Security changes clear
  session visibility before rendering new content. Forms retain non-secret
  drafts in tab memory, keyed by account/route/form; links and unloads guard dirty
  edits. Expiry never replays a mutation. Reload/compare accepts a new revision
  only through explicit review when the form is dirty. One-time recovery codes
  are excluded from command replay results and all account DTOs.

## Mock decisions and walkthrough

The fixture email for each existing account is `<account-id>@example.test`, for
example `owner@example.test` or `developer@example.test`. The authenticator is a
deterministic fake code shown in development tools. It is not a TOTP or a secure
production identity implementation. Mock links expire after 15 simulated minutes,
invitations after seven days, sessions after one hour, and fresh authentication
after five minutes. These values and mock terms `mock-2026-09` are demonstration
defaults, not production policy. GitHub is a simulated configured provider that
must first be linked from account security. Notification preferences control the
recorded optional-notification setting; security invitations remain available in
the local inbox regardless of that preference.

1. Start `bun run --cwd products/carbon-cloud dev:mock`, open `/sign-up`, enter
   fake details and accept the displayed mock terms. Follow the pending signup
   link in the development inbox and complete verification.
2. Create an organization and data project. Open the returned environment
   progress, advance the mock clock and reload; IDs and completed bindings stay
   intact. Arm provisioning failure, create another environment, advance time,
   retry its failed operation and advance again.
3. Invite `new@example.test` as Developer with a selected project ID. Switch to
   the new-account fixture; review the invitation from Organizations and accept.
   Other tenants/projects remain hidden and production configuration/data reads
   are denied until corresponding grants are assigned by an administrator.
4. Open Account security, start MFA enrollment, enter the development
   authenticator code and save the displayed recovery codes. Sign out and sign
   in with email proof plus MFA. Use a recovery code once, then confirm reuse
   grants no session. List/revoke other sessions.
5. Propose an ownership transfer from Members after fresh authentication. Sign
   in as the recipient and accept from organization settings/notifications.
   Enable organization MFA policy with an MFA-verified owner; unverified sessions
   lose organization access but retain access to account security enrollment.

## Verification and backend handoff

Focused coverage extends the existing browser checks by four adapter workflow
tests and one component check for recovery-code visibility. It covers one-use
proof, MFA/recovery/provider linking, invitation rotation and email matching,
grant isolation/revocation, ownership acceptance, session revocation, idempotent
creation, partial provisioning/reload/retry and production/pause policy.

Commands: `typecheck:browser`, `test:browser`, `build:mock` and
`check:mock-assets` in `products/carbon-cloud`. The existing 24 browser checks
plus five targeted additions pass. A visual browser walkthrough was unavailable:
the browser-control tool reported no connected browsers.

Real implementation belongs to the existing Cloud identity/catalog owners and
shared auth capability (BE-01/02/03), with operation/event/audit persistence in
BE-11. No new backend route is claimed. Before HTTP handoff, replace fake proof
and plaintext mock recovery storage with secure challenge delivery, verified
provider callbacks, proper MFA/recovery verification/storage, secure browser
sessions/CSRF protections and deliberate production policies. No HTTP fallback
or production token storage has been introduced.
