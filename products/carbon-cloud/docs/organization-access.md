# Organization access API

The API is composed with the real account platform under
`CARBON_ACCOUNT_AUTH=enabled`, using the same PostgreSQL connection, opaque
session cookies, exact Origin policy and CSRF protocol. Its contract is
[organization-api.openapi.json](organization-api.openapi.json).

POST `/platform/v1/orgs` with a name and unique lowercase namespace
(`slug`), fresh authentication, `Idempotency-Key` and `X-CSRF-Token`. This commits
the organization, its initial Owner membership, permission revision, event and
receipt together. It does not issue a legacy organization bearer token. Existing
organizations are not automatically adopted: `human_managed` defaults to false,
and only the new creation transaction sets it true. The explicit legacy claim
flow remains pending.

GET the collection or `/platform/v1/orgs/{id}` to discover the caller's
active memberships and current organization revisions. Basic summaries disclose
the MFA requirement even when the caller must still enroll MFA. Membership
identity details under `/{id}/members` require `members.manage` and the required
MFA state. Lists use ascending IDs with `limit` (1–100, default 25) and encrypted,
15-minute cursors bound to session, permission revision, scope and page size.
Member cursors additionally bind the organization revision.

POST `update`/`policy` commands to `/{id}/settings` and membership/ownership
commands to `/{id}/members` with the current **organization** revision in `If-Match`,
`Idempotency-Key`, `Origin` and `X-CSRF-Token`. Every mutation requires fresh
authentication; use the [fresh-auth protocol](account-authentication.md) on a
`fresh_required` error. Suspended or deletion-pending organizations reject writes.

| Command | Required authority and behavior |
| --- | --- |
| `update` | Owner/Admin updates name/namespace; uniqueness is enforced in PostgreSQL. |
| `policy` | Owner sets `requireMfa`; enabling requires an enrolled, MFA-verified actor. |
| `member-role` | Owner/Admin changes another non-owner's role; cannot delegate permissions absent from the actor's role. |
| `member-access` | Owner/Admin replaces another member's project assignments and explicit grants within the actor's current scope and grant duration; only an Owner may change another Owner's access. |
| `member-revoke` | Owner/Admin revokes another non-owner membership. |
| `leave` | Caller revokes their own membership. The last owner must transfer first. Required organizational MFA does not prevent leaving. |
| `ownership-propose` | Owner names an active non-owner member and the prior owner's lesser role. Replaces an older pending proposal; expires in 24 hours. |
| `ownership-cancel` | Owner cancels the pending proposal. |
| `ownership-accept` | Named recipient accepts with fresh authentication and required MFA; promotes the recipient and demotes the proposer atomically. |

Owner roles cannot be changed through ordinary role/removal commands. The pending
transfer is visible in organization details only to proposer/recipient with the
required MFA state. Role/access/removal/leave changes supersede pending proposals, and
expired, cancelled or superseded proposals cannot be accepted. A deferred database
constraint also prevents a platform-managed, non-deleted organization from ending
a transaction without an active Owner membership. Atomic ownership swaps satisfy
the constraint; raw deletion of the sole owner does not.

`accounts.permission_revision` is distinct from login `security_revision`.
Membership changes increment the affected accounts' permission and profile
revisions without invalidating their sessions in unrelated organizations. Policy
changes increment every active member's permission revision. Every API request
rechecks live session, membership and MFA authority. A removed member immediately
loses these organization endpoints while keeping any other memberships.

Organization rows serialize mutations, followed by affected account locks in a
stable order. Revision checks, changes, idempotency receipts and
`organization_security_events` commit together. Exact retries require current
authority; they never reapply an already committed mutation. The durable event
table is ready for publication, but downstream revocation delivery and stream
closure are not yet implemented or claimed.

Invitation delivery and acceptance are implemented in
[organization-invitations.md](organization-invitations.md), including real
verified-account acceptance tests. Project assignment and explicit grant administration is documented in
[platform-authorization.md](platform-authorization.md). Invitation assignments,
account deletion, legacy claims, notification UI and the real production browser
adapter remain pending. Earlier membership-management cases use explicit persisted member
fixtures; invitation cases separately cover the actual enrollment path. Existing
mocks remain separate.
