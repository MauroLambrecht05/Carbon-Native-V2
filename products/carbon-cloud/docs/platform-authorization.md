# Live platform authorization

The account platform composes PostgreSQL-backed access resolution and membership
grant management when `CARBON_ACCOUNT_AUTH=enabled`. These endpoints use the same
opaque session, exact Origin policy, no-store responses and safe error contract as
the [account API](account-authentication.md). Wire contracts are in
[organization-api.openapi.json](organization-api.openapi.json).

GET `/platform/v1/orgs/{orgId}/access` with optional `projectId` and
`environmentId` returns an `AccessSnapshot`: effective permissions at exactly the
requested scope and current account-permission, membership, organization and
optional project/environment revisions. Environment requires project. Unknown or
duplicate parameters are rejected. Realm authority remains an explicit 501.

Resolution locks the organization and account, revalidates session security,
membership and required MFA, then reads canonical parent relationships,
assignment and unexpired grants. Foreign or unavailable catalog identifiers return
404. A snapshot guides the UI; it is not a bearer credential or authorization for
a later operation. Future downstream commands must recheck the exact resource
scope and current grants, including natural expiry, at execution time.

Role ceilings limit which explicit permissions a role can receive. They are
separate from presets. Owners/Admins have all projects by default; Developer,
Viewer and Billing default to assigned projects, with an empty list meaning no
projects. An explicit `assigned` setting also restricts an Owner/Admin. Developer
and Viewer receive no customer-data access without a grant. Developer resource
configuration is included for assigned development/staging scopes; production
configuration requires an explicit grant. Admin signing requires a grant. Billing
receives only billing authority. Project policy must permit production mutations
even for an Owner. Suspended organizations, archived projects and paused
environments remove resource-write permissions while retaining allowed reads.

GET `/platform/v1/orgs/{orgId}/members/{membershipId}/access` lets an Owner/Admin
inspect stored configuration, including expired grants. POST a `member-access`
command to `/platform/v1/orgs/{orgId}/members` to replace that configuration:

```json
{
  "kind": "member-access",
  "membershipId": "44444444-4444-4444-8444-444444444444",
  "projectAccess": "assigned",
  "projectIds": ["22222222-2222-4222-8222-222222222222"],
  "grants": [{
    "permission": "data.read",
    "scope": {
      "orgId": "11111111-1111-4111-8111-111111111111",
      "projectId": "22222222-2222-4222-8222-222222222222"
    }
  }]
}
```

Send the current organization `If-Match`, `Idempotency-Key`, `X-CSRF-Token` and
configured Origin. Fresh authentication and organization MFA are required. The
command supports up to 100 project IDs and 32 grants within the 8 KiB HTTP body
limit. Optional grant `expiresAt` must be a future timestamp. Only one grant per
permission/scope is allowed. Another administrator must change the actor's own
access; only an Owner can change another Owner's configuration.

The actor must currently hold each granted permission at its canonical scope for
at least the requested duration. A permanent grant requires permanent authority.
Project assignments must also be within the actor's accessible projects. An
administrator restricted to assigned projects cannot delegate all-project access
or organization-wide grants. Role changes, ownership proposals and Admin
invitations also enforce project boundaries to prevent indirect scope expansion.
Validation and authorization happen before replacement; failed commands preserve
the entire old configuration. Changes, membership/account/organization revisions,
audit-outbox event and safe idempotency receipt commit together. Exact retries
recheck current management authority and return the stored receipt.

Role downgrades delete grants outside the new role ceiling. Membership revocation
and leave erase every assignment and grant and reset the project-access mode.
Re-invitation does not restore old privileges. Access changes also invalidate
pending invitations issued under the old membership revision and supersede
pending ownership proposals.

Migration `0013_canonical_catalog.sql` adds canonical project/environment identity,
composite foreign keys for tenant-consistent assignments/grants, and durable
catalog command/event storage. It does not fabricate catalog records or claim
legacy organizations. Catalog creation, project policy and durable provisioning are now implemented
in [catalog-provisioning.md](catalog-provisioning.md). Earlier authority tests
seed catalog records explicitly; newer catalog tests exercise actual HTTP creation.
Receiving service endpoints and end-to-end remote provisioning remain pending. Invitation assignment input, downstream assertion authority,
revocation publication/stream closure and audited customer-data endpoints remain
separate unfinished work. Administrative data reads will require auditing at
those endpoints; reading this permission snapshot does not access customer data.
