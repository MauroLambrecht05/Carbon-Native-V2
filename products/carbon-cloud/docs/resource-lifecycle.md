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
- **Deleted:** the resource is gone from every list and lookup (404). Rows are
  kept and marked deleted; nothing is physically removed, and a deleted
  project's namespace is not reused.

## Final deletion

A legal hold on the organization, or (for the organization itself) a
subscription the provider may still charge, stops a deletion from becoming
final: see [billing-operators.md](billing-operators.md).

`bun run --cwd products/carbon-cloud lifecycle-sweeper` makes deletions final
once their window has passed: environments and projects first, then
organizations. Deleting a project deletes its remaining environments. Open
worker leases for a deleted environment are cancelled. The sweeper marks rows;
it does not call Carbon Database or Carbon Registry and destroys no owning-service
data.

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
