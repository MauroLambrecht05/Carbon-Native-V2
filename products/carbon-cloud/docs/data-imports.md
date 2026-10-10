# Durable relational imports

Cloud stages bounded CSV/JSON imports in PostgreSQL and dispatches them to the
owning Database service through a separately supervised worker. This workflow
uses the canonical environment binding, native row policies and durable Database
command receipts. It has no mock fallback. Structural review remains available
through `rows.import-preview`; see [account data](account-data.md).

## Configuration

Apply Cloud migrations through `0015_data_import_jobs.sql` and Database migrations
through `0007_managed_data_constraints.sql`. Enable account authentication and
the existing signed service/live-authority configuration described in
[service lifecycle](service-lifecycle.md). Configure:

```dotenv
CARBON_DATA_IMPORTS=enabled
CARBON_DATA_DATABASE_ORIGIN=https://database.example.com
```

Cloud and its import worker share `DATABASE_URL`, the account envelope keyring
(`CARBON_ACCOUNT_ACTIVE_KEY_ID`, `CARBON_ACCOUNT_ENCRYPTION_KEYS`) and assertion
signing configuration. The worker does not require email-provider credentials.
Database must trust the Cloud issuer and use its configured live authority URL.
Keep old envelope keys while pending or unresolved operations reference them.

```powershell
bun run --cwd products/carbon-cloud data-import-worker
```

Run multiple supervised workers for availability. PostgreSQL leases coordinate
claims across processes. Disabled or missing import configuration returns an
explicit capability error from the account routes.

## Account API

The base path is
`/platform/v1/orgs/{orgId}/projects/{projectId}/environments/{environmentId}/data/imports`.
All three endpoints use POST, the account cookie, the configured Origin, a
session-bound `X-CSRF-Token`, JSON and no query parameters. Responses are private
and `no-store`. See [OpenAPI](data-import-api.openapi.json).

- Enqueue at the base path with `DataImportJobCreate`: `kind: "import.enqueue"`,
  command UUID, table UUID/revision, policy-preview access and `DataImportInput`.
  `Idempotency-Key` must equal the command UUID and `If-Match` must equal the table
  revision. Returns 202 with `receipt: DataImportJobReceipt`.
- Poll `/{operationId}/status` with `{}`. Returns `DataImportJobView`, including
  the canonical operation, table ID, `outcomeUnknown` and nullable final result.
- Cancel `/{operationId}/cancel` with a new command UUID and the current operation
  revision; matching idempotency and revision headers are required. Returns 202
  with a receipt. The creator or an organization manager can cancel.

Enqueue and execution require current `data.write`, recent authentication and
the captured project/environment authority revisions. Polling and cancellation
require current metadata access; they do not require fresh authentication.
An organization can have at most 100 pending imports. Retrying an identical
enqueue returns the same operation; changing intent under that command UUID
conflicts. Cancellation receipts also survive retries. A schema revision is
validated against Database during execution; 202 does not promise that it matches.

Source is limited to 256 KiB UTF-8, 1,000 rows and 100 distinct source columns.
The full signed envelope is limited to 384 KiB. Account requests support policy
preview only, including an optional selected user; this is not application-realm
or unrestricted administrator access. Defaults, exact numeric values, primary-key
conflict modes, confirmation for updating imports, and atomic/partial behavior
follow [native import execution](native-data.md#native-import-execution-primitive).

## Commit, recovery and cancellation

The source is envelope-encrypted with associated data binding its operation,
scope and service binding. Public status, events and receipts contain no source
text or row values. Known terminal outcomes erase the staged ciphertext.

An execution lease lasts 45 seconds. The signed request binds the operation,
lease, source, action and original account credential. Database checks current
Cloud authority before work and immediately before commit. Requests have a
20-second transport deadline, individual SQL statements a 5-second deadline,
and the import loop a cumulative 15-second execution budget. These are bounded
small imports, not a large-file ingest service.

Every reclaimed or interrupted attempt starts with receipt reconciliation.
Database serializes receipt lookup with the original command's transaction;
replacing the lease invalidates old write assertions. Only a confirmed absent
receipt allows another execution or confirmation that cancellation took effect.
A committed receipt settles the job without applying rows again, including when
the first response was lost or cancellation arrived after commit.

Cancellation of an unclaimed job is immediate. Cancellation after a claim remains
`cancel_requested` until reconciled. A final live check rejects a running write
whose cancellation or authority changed; atomic and partial modes both roll back
all effects in that case. Expected per-row failures in partial mode instead
commit accepted rows with complete counts and up to 100 safe error records.

Retries use exponential delays capped at 60 seconds, a 15-minute job deadline and
at most eight attempts eligible to execute. A final receipt check may follow the
last failed execution. Transient reconciliation failures cannot cause a blind
retry. Metadata-only reconciliation can use the account's current permission
revision after write access is revoked; it still requires the original live
session and security state. Expired freshness, changed configuration or write
permissions prevent new execution.

If the receipt cannot be checked after potential dispatch, the operation ends
`failed` with `outcomeUnknown: true`. This is an unresolved commit outcome, not
proof of rollback. Its encrypted source remains retained for operator review;
automated operator reconciliation and retention cleanup are not implemented yet.
Do not create a replacement command solely because such an operation failed.

The separate internal endpoints are
`POST /internal/platform/v1/environments/{environmentId}/imports/{operationId}/execute`
and `/status`, with canonical `orgId`, `projectId` and `bindingId` query parameters.
Both accept `DataImportServiceRequest`; execution uses `data.write` and an
idempotency header, status uses `metadata.read` and no idempotency header.
Ordinary `DataRequest` and `AccountDataRequest` continue to reject the native
`rows.import.apply` command.

Private export/download jobs, large imports, application realms, operator repair
and broader production cutover remain separate unfinished work.
