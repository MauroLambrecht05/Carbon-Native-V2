# Slice 6: data extensions

Implemented against sections 12, 13 and 15 and slice 6 of section 22.2 in the
[platform plan](platform-frontend-plan.md). All behavior is local mock behavior.
No Cloud, Database, storage, SQL, auth provider, embedding provider or native
runtime service is contacted. Functions remain slice 7.

## Routes and stories

| Routes | Coverage |
| --- | --- |
| `E/storage`, `E/storage/:bucketId` | BLOB-01–10: private-default buckets, explicit public/anonymous policy confirmation, MIME/size limits, per-user prefixes, paginated prefix/search listing, binary files, independent upload progress/cancel/retry, revision-aware replacement, permission-checked escaped text/hex preview and binary download, expiring local download/upload tokens, copy/move outcomes, retention-aware deletion and version restore. |
| `E/database/vectors`, `E/database/vectors/:collectionId` | VEC-01–06: immutable dimensions/metric, insert/upsert/import JSON with per-point validation, metadata filters, bounded top-K scores, point/collection deletion, tracked simulated index progress/failure, usage and adapter recipe. |
| `E/database/graph` | GRAPH-01–05: multiple scoped graphs; create/edit/import nodes and edges; atomic import with preview/per-item errors; label/property/neighbor filtering and pagination; endpoint links; directed shortest paths; explicit dependent-edge deletion. |
| `E/realtime`, `E/realtime/inspector` | RT-01–05: configure table event types, connect using the current verified app session, inspect committed events and authorized rows, cursor replay, disconnect/resume, gap/refetch, and policy/session revocation checks. |
| `E/database/migrations` | MIG-01–06: ordered immutable forward SQL/checksums, reviewed reverse, expected schema fingerprints, drift/compatibility preview, tracked apply/cancel, actual-outcome inspection, reviewed promotion with predecessor checksums and target backup readiness, supported rollback. |
| `E/database/backups` | BACKUP-01–06: coverage manifests, tracked snapshots, protected recovery points, daily timezone/retention configuration, expiring authorized export, new-environment restore default, explicit replacement of existing targets, write/job pause and per-resource partial outcomes. |

Environment navigation links all six areas. Direct bucket and collection
routes resolve records independently of catalog pagination. A missing binding
requires explicit Database provisioning; app-user snapshots and app-identity
storage/realtime access additionally require a ready Auth binding.

## Contracts and persistence

`presentation/framework/services/extension-contracts.ts` defines
`ExtensionService` and its DTOs. The composed `services.extensions` port exposes:

- `list`, `getResource`, `command` with the typed `ExtensionCommand` union.
- `objects`, `upload`, `download`, `createLink`, `useLink`.
- `vectorPoints`, `vectorSearch`, `graphRecords`, `graphPath`.
- `subscribe` for policy-filtered row events.
- `schemaStatus`, `previewMigration`, `previewRestore`.
- `backupExportAccess`, `backupDownload`, `jobResult`, `cancel`.

The port reuses canonical `Scope`, abortable `RequestContext`, `Result`, opaque
revisions/cursors, command idempotency and operation receipts. Extension state
is an additive schema-v1 IndexedDB collection. Existing slices and workspaces
are preserved. Binary bytes are serialized as numeric byte arrays inside the
local transactional workspace; metadata DTOs omit bytes. Downloads construct
local Blob URLs only after the adapter rechecks authority.

`extension-state.ts` owns normalized records and transactional row-event
capture. `extension-engine.ts` validates binary policies, vectors, graph imports
and job authority. `extension-recovery.ts` reconciles persisted job deadlines,
snapshots, migrations, schedules and restore results. `extension-services.ts`
provides browser ports. Pages call the ports through the existing scoped query
cache and shared revision-aware command forms.

## Authorization and lifecycle

Every dashboard call resolves current canonical tenancy and the trusted
session. Metadata access never grants blob bytes, vector points, graph content,
realtime payloads or backup exports. Contents require `data.read`; content writes
require `data.write`; configuration requires `resources.configure`. Recovery
mutations require configuration and data grants. Production commands require
the existing environment policy confirmation. Replacing a production restore
target uses the stronger exact `RESTORE <environmentId>` confirmation plus its
current scoped permissions.

Storage's anonymous/app options are policy-evaluation modes inside the
authorized dashboard console. They do not grant a dashboard session to an app
user. App mode uses the active realm session, never an arbitrary user ID.
Anonymous uploads are explicitly opt-in. User prefixes must include exactly
one `{userId}` and a trailing slash. Keys are opaque, never filesystem paths or
decoded URLs. Dot segments, absolute paths, controls and backslashes are refused.

Local transfer tokens bind scope, bucket policy revision, key, object revision,
creator session and expiry. Upload tokens are one-use. Bucket policy changes
invalidate outstanding tokens; private objects never become permanently
public. Public access is rechecked immediately in this mock; real CDN caching
and recalling downloaded copies are outside the contract. Snapshot export
leases bind snapshot, scope and current session for 60 mock seconds.

Jobs use `data.extension` operations with three steps. Reconciliation rechecks
the original actor's live session, permissions, production intent and resource
revisions before commit. Cancellation is acknowledged before commit; terminal
operations cannot be cancelled or silently replayed. Generic operation controls
cannot bypass the domain cancellation port. Failed transfers/indexes/migrations
are explicitly resubmitted after reviewing current results/revisions.

Mutations produce safe audit and invalidation records. Realtime events are
captured after successful transactions, including completed supported SQL and
import jobs. Events contain stable IDs, monotonic cursors, table/row IDs,
revision, timestamp and old/new values; both versions and current surviving
rows must satisfy the current app-user SELECT policy before delivery. Session
rotation/revocation/expiry closes the subscription. The inspector displays the
latest authorized batch and clears it on policy reevaluation/disconnect, rather
than retaining a stale client-side payload history.

## Recovery semantics and limits

- Binary fixtures: 2 MB per file, configurable lower bucket limit, 10 MB per
  environment including retained versions; exact MIME allowlists. HTML/SVG is
  never executed. Text is escaped and capped at 10 KB; binary preview is hex.
  Replace retains old versions when versioning or retention requires it.
- Copy and source deletion report separately. Failed copies preserve the
  source. A successful copy can coexist with failed retention-protected source
  deletion. Recursive bucket deletion checks every version before committing.
- Vectors: 1–128 fixed dimensions, at most 1,000 points/collection and top-K
  1–100. Euclidean/cosine distances sort ascending; dot similarity descending;
  ties sort by ID. Cosine rejects zero vectors. Inputs must be finite and bounded.
  Index state is simulated; all queries use exact deterministic calculations.
- Graphs: directed, nonnegative bounded finite edge weights, at most 1,000 items
  per import. Both endpoints must exist in the same graph. All-or-nothing import
  follows validation; no-path is separate from validation/authorization failure.
  There is no app-client graph/vector access capability in this slice.
- Realtime: retains 200 committed events. An expired replay cursor reports a
  gap and refetches authorized rows. The source is accepted mock application
  commits, including the supported SQL fixtures; it is not a backend WAL feed.
- Migration v1 supports `CREATE TABLE name (id uuid PRIMARY KEY, title text);`
  and an explicitly reviewed reverse `DROP TABLE name;`. Unsupported SQL fails
  without execution. Checksums/fingerprints are deterministic fixture values,
  not cryptographic attestations. Applied SQL is immutable; drift is visible and
  requires explicit reconciliation. Promotion registers the reviewed revision
  on the target for separate preview/application there.
- Snapshot coverage: relational schema/rows, policies, blob versions, vector
  points, graph, and app-user metadata. Policies require relational coverage.
  App sessions, platform credentials, signing private keys, secret values and
  function source/configuration references are excluded. PITR and cross-service
  transactional snapshots are explicitly unavailable. The consistency boundary
  is one local mock transaction at snapshot commit.
- Daily schedules use IANA timezone/local-hour settings, retain 1–90 days, and
  coalesce missed intervals when the mock clock advances. They recheck the
  creator's session/access; expired authority skips with a recorded outcome.
  Protected backups are never removed by retention. Active restores pin their
  source backup. There is no background server scheduler while the page is closed.
- New restore targets are development environments with Database/Auth bindings.
  Existing targets require exact confirmation, ready state and no competing
  operations. Selected categories replace existing records; writes pause until
  the restore is terminal. Relational restore without policies is fail-closed.
  Old app sessions/proofs are invalidated; restored app metadata gets target-realm
  IDs, with owned rows/prefixes remapped when included. Unincluded user identities
  are not recreated, and their orphan data remains subject to policy denial.
- Partial restores retain successful categories and mark the overall operation
  failed. Results list restored/skipped/failed resources and the target ID. Retry
  explicitly selects failed categories; no automatic replay of successful work.
  Cancelling a new-target restore keeps its provisioned empty environment for
  inspection. Snapshot restore does not restore migration history or credentials.

## Functional walkthrough

1. Select Owner, Acme North / Notes / development. Enable Auth in environment
   overview and advance the mock clock five seconds if it is not already ready.
2. Create a private versioned bucket, upload a binary file, and advance three
   seconds. Inspect exact bytes/version metadata, deny anonymous download, create
   a one-second token, advance time and observe expiry. Replace by reviewed
   revision, restore an old version, and exercise copy failure and cancellation.
3. Create a 2D Euclidean collection. Import `[0,0]` and `[3,4]` plus an invalid
   point. Search from `[0,0]`: distances are 0 and 5; the invalid point is reported.
   Build/fail an index and inspect operation results.
4. Create a graph using the supplied nodes/edges. Preview unresolved endpoints,
   then save. Query `a` to `c` for path `a,b,c` with cost 3. Attempt deleting `b`
   without cascade and observe dependency refusal.
5. Configure `notes` realtime events. Sign in to Alice through hosted app auth,
   consume the local proof from the authorized inbox, then connect the inspector.
   Write Alice/Bob rows from another page. Only Alice's authorized events appear.
   Disconnect/resume; sign out/suspend the app user and observe closed access.
6. Register the supplied migration against the displayed schema fingerprint.
   Preview, apply and advance time; inspect the new table. Reapply is refused.
   Review reverse SQL and roll back. Edit schema outside migrations to see drift.
7. Create a protected snapshot and inspect coverage/omissions. Export it. Preview
   and restore into a new environment, optionally failing vectors. Inspect failed
   overall status, successful relational data and the failed category. Retry only
   failed coverage. Existing-target restore pauses writes and requires exact
   target confirmation. A protected backup refuses deletion.
8. Reload, switch tenant/role and revoke access during pending work. Persisted
   results remain scoped and sensitive queries/downloads recheck access.

## Verification and backend handoff

Verification uses browser TypeScript, production mock build, local asset smoke,
focused extension contract checks and the existing browser regression checks.
On 2026-09-08 all four commands passed; the browser suite reports 43 passing
checks with 375 assertions, including six focused extension contract checks.
React renderer checks cover every slice-6 route and direct collection details.
No connected browser was available for a visual walkthrough. The existing
non-blocking TanStack `use client` and shared-bundle size warnings remain.

Backend ownership stays with Carbon Database for storage/vector/graph/realtime,
migration and snapshot adapters, with Cloud canonical environments, scoped
authorization, operation/audit integration and provisioning. Implement durable
binary storage, real signed token verification, database-role/policy enforcement,
transactional row capture, job leases, actual migration semantics/checksums,
restore isolation and server scheduling before replacing these adapters with
HTTP. No silent HTTP-to-mock fallback exists.
