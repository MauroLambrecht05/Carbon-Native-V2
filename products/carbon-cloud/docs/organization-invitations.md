# Organization invitations

The real account composition exposes invitation management at
`/platform/v1/orgs/{orgId}/invitations`. It uses the existing configured Resend or
explicit development inbox adapter and encrypted PostgreSQL mail queue. The wire
contract is [invitation-api.openapi.json](invitation-api.openapi.json).

GET lists safe invitation IDs, normalized emails, roles, visible states, revisions,
inviter IDs and expiry times. It requires `members.manage` and organizational MFA.
Pagination uses ascending IDs, a 1–100 limit and 15-minute encrypted cursors bound
to the session, account permission revision, organization revision and page size.
Expired pending invitations appear as `expired`; their proofs cannot be used.

POST accepts these commands with Origin, CSRF, `Idempotency-Key` and the current
**organization** revision in `If-Match`. All new mutations require fresh auth.

| Command | Behavior |
| --- | --- |
| `create` with `email`, `role` | Queues a seven-day proof for a non-owner role. A new invitation supersedes an existing pending invitation to the same normalized email in that organization. Active member addresses return conflict. |
| `resend` with `invitationId` | Replaces the pending invitation's proof, expiry and inviter membership binding; invalidates the old proof and pending delivery. An expired pending invitation can be resent. |
| `cancel` with `invitationId` | Cancels the pending invitation and erases pending delivery payloads. |

Managers may delegate only permissions present in their own role. Admin cannot
invite Billing because Admin lacks billing management. Owner cannot be invited;
use accepted ownership transfer. Managers must have current scoped authority and
the required MFA state even when retrieving a previous command receipt.

Delivery is limited to 20 committed requests per one-hour window for each
organization, actor, normalized destination and ingress peer. Keys use the
configured HMAC secret. Exact retries do not spend quota, replace a proof or queue
another email. Reusing a key with changed input/revision returns conflict.
Delivery retries and lease recovery use the shared worker and stable per-job
provider idempotency key. A job already being sent can reach the recipient after
cancellation or resend, but its replaced/cancelled proof cannot authorize access.

The email links to `/invitations/accept#token=inv_...`. The production browser page
remains pending. The browser must keep the proof out of URL query strings and
logs, sign in through the ordinary account flow using the invited verified email,
then POST `{token}` to `/platform/v1/invitations/preview` with Origin and CSRF.
Preview returns organization name/ID, role, expiry and MFA requirement only to the
matching verified account. It does not enroll or sign in the recipient.

POST the same proof to `/platform/v1/invitations/accept` with Origin, CSRF and an
idempotency key. Acceptance requires fresh authentication, organizational MFA,
an active organization and the matching current verified email. It rechecks the
inviter's active account, role, MFA enrollment and exact membership revision.
Changing/revoking that membership invalidates the outstanding proof even if the
inviter later regains the same role; an authorized manager must resend it.

The acceptance transaction locks the organization and affected accounts in order,
consumes the proof once, creates or reactivates the membership, increments account
permission/profile and organization revisions, and commits an audit/outbox event
and durable receipt. It never silently upgrades an existing active membership.
Concurrent same-key acceptance returns the same receipt; another acceptance key
cannot reuse the consumed proof. Receipt retrieval requires current recipient
authority, and stops working after their membership is revoked.

Migration 0011 adds accepted-account and inviter-membership bindings, typed
invitation mail ownership, and an invitation reference on security events.
Historical unbound pending invitations become superseded; no legacy membership
authority is fabricated. Existing authentication/email-change/notice jobs and the
previous authentication writer's column list remain supported.

Project/environment assignments and explicit invitation grants depend on the
pending canonical catalog. The API rejects unsupported assignment fields, and
persisted nonempty assignments fail with `capability` on resend/preview/accept.
They are never reduced to a broader organization role. Downstream revocation
publication, stream closure and the production browser adapter remain pending.
