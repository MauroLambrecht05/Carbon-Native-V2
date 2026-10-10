# Audit log and event stream

Every capability writes its own event table (catalog, secrets, credentials,
service accounts, devices, personal credentials, legacy tokens, workers,
repositories, imports, organization security). Migration
`0023_platform_events.sql` projects all of them into one ordered,
organization-scoped table, `platform_events`. The wire contract is in
[audit-api.openapi.json](audit-api.openapi.json).

## How events get there

A database trigger on each source table inserts the matching `platform_events`
row in the same transaction as the source event. The log therefore cannot miss a
committed event or contain an aborted one, and no repository had to change.
Organization state changes made by Cloud itself (suspension, reinstatement,
final deletion) are written directly with a `system` actor.

Each row has the organization, optional project and environment, the action, a
resource reference (kind and identifier), the actor (`account`, `worker` or
`system`), the resource revision when the source recorded one, the request
identifier and the time. It carries no free-form metadata, so no secret or
token can reach a reader through it.

## Ordering

Rows are ordered by the writing transaction and then by sequence, and a reader
sees only rows below the oldest transaction still running. A plain sequence is
not a safe cursor: a transaction that took a lower number can commit after a
higher one was already read, and a reader that had moved past it would never see
it. The cost is that a long-running transaction delays visibility of newer
events until it ends.

## Browsing

`GET /platform/v1/orgs/{orgId}/audit` returns `AuditPage`, newest first.

- `projectId` and `environmentId` narrow the scope.
- `limit` is 1 to 100 (default 50); `cursor` continues a listing.
- The caller needs `audit.read` at the requested scope. Owners and Admins read
  the whole organization. Developers read projects they are assigned to.
  Viewers and Billing members cannot read audit events.
- A cursor is sealed to the session, its permission revision and the exact
  scope. It is rejected after any of them changes and for any other session.

## Stream

`GET /platform/v1/orgs/{orgId}/events/stream` is a server-sent event stream of
`SubscriptionMessage` frames, with the same scope parameters and permission.

| Frame `state` | Meaning |
|---|---|
| `connected` | First frame, and every frame that carries events |
| `heartbeat` | Nothing happened for 15 seconds |
| `closed` | The stream reached its 15-minute lifetime, or failed; reconnect |
| `authorization_revoked` | Access is gone; terminal, with an empty cursor |

- A new stream starts at the present; earlier events are for the audit listing.
- Each frame's `id` is its cursor. Reconnect with `?cursor=` or the standard
  `Last-Event-ID` header to resume without loss or repeats.
- Access is re-resolved on every poll (once a second). A revoked membership, a
  changed role, a changed permission revision or an ended session ends the
  stream with `authorization_revoked` and invalidates its cursors.

## Limits

- The log starts at migration 0023. Earlier events stay in their source tables
  and are not backfilled.
- Account-level security events (sign-in, MFA, sessions) are not in the
  organization log.
- Entries have no metadata beyond the fields above.
- There is no retention or export yet, and the `gap` frame is never sent.
- The stream polls the database; there is no external broker. Owning-service
  events (Database, Registry) are not included.
