# Resource lifecycle: archive, pause, suspension, deletion and recovery

Organizations, projects and environments each have one state machine. Deletion
is always a scheduled, recoverable state before it is final, and it is never the
first step.

## State machines

```
environment   active <-> paused -> deletion_pending -> deleted
                                \<---- recover ------/

project       active <-> archived -> deletion_pending -> deleted
                                  \<---- recover ------/

organization  active -> deletion_pending -> deleted
                    \<-- delete-cancel --/
              active <-> suspended            (operator only)
```

| Resource | Command | From | To | Who |
|---|---|---|---|---|
| Environment | `pause` true/false | active / paused | paused / active | `resources.configure` |
| Environment | `delete` true | paused, no running operation | deletion_pending (7 days) | Owner or Admin |
| Environment | `delete` false | deletion_pending | paused | Owner or Admin |
| Project | `archive` true/false | active / archived | archived / active | `projects.create` |
| Project | `delete` true | archived | deletion_pending (7 days) | Owner or Admin |
| Project | `delete` false | deletion_pending | archived | Owner or Admin |
| Organization | `delete` | active | deletion_pending (30 days) | Owner |
| Organization | `delete-cancel` | deletion_pending | active | Owner |
| Organization | suspend / reinstate | active / suspended | suspended / active | Cloud operators, through the operator API |

Deleting a project or environment requires the project namespace as
confirmation; deleting an organization requires its own. Every command needs a
fresh session, CSRF, the current revision and an idempotency key, and writes an
event.

`deletionScheduledAt` appears on a project or environment while its deletion is
pending.

## What each state allows

- **Paused, archived, suspended, deletion pending:** reads continue; every
  resource write is refused. The only command a deletion-pending resource
  accepts is its own recovery.
- **Suspended:** members can still sign in and read. Organization and member
  management are refused.
- **Deleted:** the resource is gone from every list and lookup (404). Cloud's
  own rows are kept and marked deleted, and a deleted project's namespace is
  not reused. What the owning services held for it is destroyed: see
  "Erasure" below.

## Final deletion

A legal hold on the organization, or (for the organization itself) a
subscription the provider may still charge, stops a deletion from becoming
final: see [billing-operators.md](billing-operators.md).

`bun run --cwd products/carbon-cloud lifecycle-sweeper` makes deletions final
once their window has passed: environments and projects first, then
organizations. Deleting a project deletes its remaining environments. Open
worker leases for a deleted environment are cancelled. The same process then
carries each final deletion to the owning services.

## Erasure

When a deletion becomes final, Cloud's database records one **erasure** for
each owning service that holds a resource for each affected environment. A
trigger does this, on the environment, its project or its organization
becoming deleted, so no code path that makes a deletion final can skip it.

The sweeper delivers each erasure to its owning service as a signed request.

- **Who may ask.** Only the platform itself. The request's principal is the
  erasure, not an account: no member, owner, service account or operator can
  ask an owning service to erase anything, and Cloud's signing key alone is not
  enough. The owning service asks Cloud whether exactly this erasure is on
  record, for this service, this resource and these request bytes, with the
  deletion final.
- **Asked twice.** Once when the request arrives, and again after the work is
  done and before it is committed. If Cloud no longer stands behind the
  erasure at that moment, everything the owning service did is rolled back.
- **Legal holds.** A hold on the organization stops erasures that have not
  been carried out yet, including a hold placed after the deletion became
  final. They resume when the hold is released.
- **Once.** An environment is erased at most once. Delivering the same erasure
  again returns the same receipt and removes nothing more.
- **Retries.** A delivery that fails is recorded with a category and tried
  again later, waiting twice as long each time up to an hour.

### What is destroyed

| Service | Removed |
|---|---|
| Carbon Database | The environment's PostgreSQL schema with every table and row in it, and its role. Its table catalog, constraints, command receipts and events. Its change feed. Its vector collections and points, graph nodes and edges, and their command receipts. Its blob buckets, object records, transfers, command receipts, events and usage records, and the objects' bytes in the bucket |
| Carbon Registry | The environment's namespace |

Blob bytes are outside the database, so they cannot be removed in its
transaction. Their keys are written down in that transaction and the bytes are
deleted straight after it commits. If the object store is unavailable, the
keys stay listed and are tried again every minute until none are left.

The owning service keeps the environment's row, marked `erased`, and the
receipt. An erased environment cannot be provisioned again, and neither record
can be changed or removed. Cloud keeps the erasure and the receipt, which says
how many of each kind of thing were removed, and writes
`environment.erased.database` or `environment.erased.registry` to the
organization's log.

### What is not destroyed

- **Registry publishers and published packages.** They belong to the
  organization, not to an environment, and are public: other projects may
  depend on them. A deleted organization's publisher names stay reserved and
  its published versions stay downloadable. This is a default, recorded for
  the owner to confirm (G-09).
- **Cloud's own rows** for the environment: its secrets (encrypted), function
  code, executions, builds and their logs, releases, app users and events are
  marked or left, not removed (G-09).
- **Build and release artifacts and table exports** in Cloud's buckets (G-47,
  G-62).
- **Backups.** There are none (G-135).

Erasure needs `CARBON_PROVISIONING_DATABASE_ORIGIN`,
`CARBON_PROVISIONING_REGISTRY_ORIGIN` and Cloud's assertion signing key on the
sweeper, the settings the catalog worker already uses. Without them deletions
are still made final, their erasures stay on record undelivered, and the
sweeper says so when it starts.

## Revocation propagation

No credential carries its own copy of resource state. Each verification
re-reads the organization, project and environment, so a state change takes
effect on the next use without a separate revocation step.

| Credential | Suspended org | Archived project | Deletion-pending or deleted environment | Paused environment |
|---|---|---|---|---|
| `pt_` personal | refused | refused | refused | refused |
| `dc_` device | refused | refused | refused | refused |
| `cs_` service account | refused | refused | refused | reads only |
| `ce_` environment | refused | refused | refused | reads only |
| `wc_` worker lease and secret delivery | refused | refused | refused | refused |

Recovery restores every credential: reinstating the organization, restoring the
project, or recovering and resuming the environment.

While an environment is paused, automation credentials (`cs_`, `ce_`) are
accepted for `metadata.read` and `data.read` only. A write assertion issued
before the pause stops being current, and no new one is issued until the
environment resumes.

Before this phase, `cs_` and `ce_` verification and the service authority for
`cs_`/`dc_` assertions accepted any environment that was not finally deleted.
They now require active or paused.

## Tenant isolation

A two-tenant matrix test sends 69 reads and changes from one organization's
owner at another organization's resources, including the other tenant's
identifiers placed under the caller's own organization. Every one returns 403 or
404, no response contains the other tenant's names, identifiers or secrets, and
the other tenant's rows and event count are unchanged afterwards.

## Not included

- An operator HTTP surface for suspension (Phase 16); the use case exists.
- Destroying owning-service data and object storage after final deletion.
- Notifying members about scheduled deletion.
- Owning services (Database, Registry) do not yet learn about deletion beyond
  the live authority checks they already make.
