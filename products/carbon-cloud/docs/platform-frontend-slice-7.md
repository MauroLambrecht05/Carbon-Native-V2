# Slice 7: functions

Implemented against section 14 and slice 7 of section 22.2 in the
[platform plan](platform-frontend-plan.md). Everything runs through local mock
adapters. Source text is never evaluated, imported or sent to a service.

## Routes and stories

| Routes | Coverage |
| --- | --- |
| `E/functions` | FN-01: searchable, paginated function catalog; create from a source fixture or a repository-relative path; execution limits and configuration guide. |
| `E/functions/:functionId` | FN-02–04, 06–09, 12: revision-aware draft autosave; immutable deployments; package/validate/activate progress and cancellation; named fixture execution; target-reviewed promotion, compatible rollback, authorization configuration, secret bindings and disable/delete. |
| `E/functions/:functionId/invocations/:invocationId` | FN-04–05, 11: direct invocation metadata; opt-in content gated by data permission; bounded redacted inputs/outputs/logs; status, duration, request ID, deployment, trigger and retry lineage; cancellation and retry. |
| `E/functions/:functionId/schedules` | FN-10: create/edit/disable/delete schedules; timezone-aware next-run preview; missed-run and overlap policies; credential validation and recorded outcomes. |

Environment navigation includes Functions. Existing environments require explicit
Functions provisioning through overview; there is no implicit second environment
identity. Database/Auth bindings are independently required for resource/app
identity fixtures. Missing records, unprovisioned capabilities, forbidden writes,
empty results, stale revisions and expired sessions use the shared feedback and
scope cache behavior. Invocation history filters status, trigger and ISO time
bounds. Catalogs, deployments, operations, schedules and invocation history expose
pagination; direct resource routes do not depend on list membership.

## Adapter and persisted records

`presentation/framework/services/function-contracts.ts` defines `FunctionService`
and its DTOs. Browser composition exposes `services.functions`:

- Queries: `limits`, `list`, `get`, `deployments`, `invocations`, `invocation`,
  `schedules`, `previewSchedule`.
- Commands: typed `command` union for create/save/deploy/promote/rollback/status
  and schedule save/delete; `invoke`, `retry`, `cancel`, `cancelDeployment`.
- Shared operations: `function.deploy` records, queried by the existing operation
  service. Generic cancel/retry controls cannot bypass the function adapter.

All calls use canonical scope, abortable request contexts, `Result`, revisions,
opaque cursors and command idempotency. `function-state.ts` adds normalized
functions, successful deployments, deployment jobs, invocations, schedules and
per-invocation usage to the existing schema-v1 workspace. IndexedDB transactions
serialize changes across tabs; reload resumes persisted deadlines. Explicit mock
reset removes the function collection. Other slice state is preserved on upgrade.

Source drafts contain source text, optional repository path, selected fixture
handler, authorization policy, memory/timeout/concurrency configuration, resource
grant and secret IDs. Autosave waits 900 ms after editing pauses. Errors suspend
autosave until reviewed; conflicts show the current server draft and require an
explicit revision choice. Production autosave needs the environment confirmation.
Navigation/unload guards protect unsaved editor changes.

Successful deployments snapshot source/configuration, a deterministic synthetic
source digest, secret IDs and versions, creator and optional promotion lineage.
Only activation moves the function's active pointer. Draft edits do not rewrite
deployments. Promotion preserves the source digest and validates target-scoped
configuration, resources, secrets and permissions. Existing target drafts remain
separate from the promoted snapshot. Pending operations reject concurrent changes
to the target function; validation failure retains its previous active deployment.

## Authority and execution

Every dashboard call resolves the trusted current session and canonical tenancy.
Metadata requires `metadata.read`; management requires `resources.configure`;
console invocation/cancellation requires `data.write`; request/response/log
inspection requires `data.read`. Retrying requires both data permissions. These
are the existing explicit project/environment grants, including production
permissions. Mutation confirmation does not grant permission. Production promotion
confirms the target, while the source is authorized for reading/management.

Execution separately requires the deployed policy: anonymous, an active verified
realm app session, or a live environment backend credential with `functions:invoke`.
Dashboard access never supplies an invocation identity. The console selects a
credential fixture by metadata ID under its authorized data-write permission;
this is a simulation, not a production authentication mechanism. CI, worker,
operator and app audiences cannot act as dashboard administrators.

Read-row fixtures require a declared same-environment table. Anonymous/app calls
apply the existing SELECT policy and current app-user state. Read-blob fixtures
require a declared bucket/key and apply its public/user-prefix policy. Service
identities additionally require explicit `database` resource and `data:read`
credential grants. No platform administrator credential is inherited. Resource
fixtures are read-only in this slice; arbitrary code and mutation handlers are
not simulated. Database-event triggers remain unavailable.

Queued work rechecks binding readiness, restore locks, function status, secret
availability and invocation identity before completion. Dashboard-triggered work
also rechecks its original account session, membership and production policy.
Switching the active app session cannot silently change a queued invocation's
app identity. Scheduled work uses its backend credential independently of the
author's dashboard session; credential expiry/revocation blocks later runs.

## Lifecycle, limits and side effects

- Deployments simulate package, validate and activate at one-second intervals.
  Failed jobs are explicitly resubmitted after reviewing source/bindings. Cancel
  is acknowledged before activation; terminal jobs cannot be cancelled.
- Invocations transition queued → running → succeeded/failed/timed_out, with
  cancel_requested → cancelled. User exceptions, infrastructure failures,
  authorization failures and timeout are distinct. `echo`, `user-error`,
  `infrastructure-error`, `timeout`, `read-rows` and `read-blob` are named fixture
  handlers. No `eval`, `Function`, user-code import, network or filesystem access.
- Adapter limits: 16 KB request, 100–30000 ms timeout, 128/256/512 MB memory
  configuration, concurrency 1–4, and at most 20 pending invocations/environment.
  Memory is contract metadata; the mock does not claim to allocate isolated VMs.
  Responses are bounded, row output is capped at 50 and binary output at 256 bytes.
- Secret-like JSON fields and all headers except content-type/x-request-tag are
  redacted before persistence and fixture handling. Bearer/credential strings are
  redacted; arbitrary text cannot be guaranteed to contain no sensitive data.
  Content still requires data-read permission. Audits contain identifiers/outcomes,
  never raw source, request, response or secret values.
- Secret bindings expose metadata only. Current enabled drafts, active deployments
  and pending work block removal. Replacement increments the version for future
  snapshots; existing deployments keep their pins. Disabled functions release
  dependencies after pending work terminates. Historical snapshots retain IDs and
  versions, so missing bindings can prevent re-enable or rollback.
- Retries create a new invocation of the original deployment with its original
  reference and forwarded business key. Command idempotency prevents duplicate
  submission, not repeated business side effects. There is no exactly-once claim.
- Usage records are keyed once per invocation with execution duration, excluding
  queue wait. Billing aggregation remains slice 9. Material changes emit safe
  activity/invalidation events. Content reads are audited without invalidating
  themselves. Scope/session revocation clears shared cached projections.
- Disable/delete refuses new invocations, disables schedules and requests pending
  work cancellation. Re-enable does not restart schedules. Deployment/invocation
  history is retained until explicit retention policy work; no production retention
  period or actual deletion of backend code is implied.

Schedule syntax supports every minute (`* * * * *`), a minute interval that divides
60 (`*/N * * * *`), or a fixed minute with an hour or hourly wildcard (`M H * * *`).
Times are previewed in UTC using an IANA timezone. Repeated DST minutes occur
twice; nonexistent local minutes are skipped. A late occurrence is skipped or
coalesced into at most one catch-up invocation. Overlap is recorded as skipped or
admitted to the normal bounded queue. Each occurrence advances its persisted
cursor in the same transaction as enqueue/outcome recording. Failure is visible
in invocation history or the schedule outcome/audit; no unbounded automatic retry.

## Walkthrough and verification

1. Select Owner; enable Functions (and Auth for app identities) in development
   overview. Open Functions, create a draft, edit it and observe autosave.
2. Deploy; advance the mock clock four seconds. Invoke using the deployed policy,
   advance again and open details. Toggle content to see the redacted fixture.
3. Edit the source/config; simulate failed deployment and verify the original
   active ID remains. Deploy successfully, then activate a prior snapshot.
4. Create/bind a secret; verify removal is refused. Replace it and compare old/new
   deployment version pins. Disable the function and inspect retained history.
5. Select error/timeout handlers and retry failures; inspect distinct invocation
   IDs, original links and duration. Cancel queued work and inspect acknowledgement.
6. Provision production, review a source deployment and target configuration,
   confirm the target ID, promote and inspect its deployment operation.
7. Deploy service-credential authorization, issue a narrow backend credential and
   create a schedule. Preview timezone/DST behavior, advance the clock, inspect
   missed/overlap outcomes, revoke the credential and observe refusal.
8. Use row/blob fixtures to inspect policy denial, revoke an app session while work
   is queued, reload pending jobs and switch to Viewer to confirm content gating.

`tests/browser/functions.test.ts` covers these adapter contracts, idempotency,
scope/audience isolation, promotion, concurrency, dependencies, recovery, resource
policies and scheduled authority. The presentation test exercises explicit
provisioning, actual autosave, the deploy form and direct function/invocation/
schedule routes. Run the standard browser typecheck/tests, mock build and asset
smoke check from the product README.

## Backend handoff

The future Database adapter can map resource storage to the existing
`products/carbon-database/infrastructure/services/EdgeFunctionsEngine.ts` and its
HTTP routes. Its current in-process `AsyncFunction` execution is not an isolation
boundary and is never imported by the mock. Before enabling a real adapter,
implement constrained isolated execution, canonical tenant/auth enforcement,
immutable source packages/config/secret-version storage, authenticated invocation
endpoints, durable queues/logs/usage, schedule leases/cursors, cancellation and
retention. Reconcile supported public-client contracts before publishing SDK
examples. This slice does not invent exported SDK methods or a working HTTP URL.
