# Native relational data foundation

Database migration `0003_native_tables.sql` and `@carbon/data` now provide real
canonical table storage and PostgreSQL row-level policies. Database composition
exposes the adapter as `deps.nativeTables`. The [signed data protocol](signed-data.md)
now connects it to internal HTTP routes and durable command receipts, using shared
wire contracts. [Account-facing Cloud forwarding](account-data.md) now exposes
authorized catalog/schema reads, generated types and durable mutations.
Application realms and the production frontend adapter remain unfinished.

## Native enforcement

Each table has an opaque UUID, a stable `ct_<uuid>` physical name inside its
canonical environment schema, a display name and a schema revision. Composite
foreign keys bind its metadata to the owning service's existing canonical
environment resource. The environment row is locked while a request executes,
so native pause/state changes serialize with data work. Writes require an active
environment; reads remain possible while paused if policy permits.

Tables always have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
A restrictive policy requires matching transaction-local organization, project
and environment IDs. Explicit permissive rules then authorize rows:

- `owner` matches a UUID/text column to the transaction's application user ID,
  with an explicit subset of select/insert/update/delete operations.
- `public-read` permits select only within the matching environment context.
- A disabled or empty policy set denies application rows. It does not turn off
  native RLS or make data public.

Unsupported rules, unknown columns, duplicate rule IDs/operations, arbitrary SQL,
and public write rules are rejected. Policy replacement requires the current
schema revision and commits native policies, catalog metadata and an audit event
together. Unexpected unmanaged native policies require review rather than being
silently removed.

Native `USING` predicates check existing rows and `WITH CHECK` checks proposed
rows, including BEFORE-trigger changes. Failed checks abort the statement and
transaction. SELECT policies also participate in operations that read/return
rows. These behaviors follow the [PostgreSQL policy semantics](https://www.postgresql.org/docs/16/sql-createpolicy.html).
The implementation verifies these behaviors against real PostgreSQL rather than
relying on an in-process policy evaluator.

## Supported persistence operations

The internal repository currently creates tables, replaces policies, reads bounded
pages by stable row ID, inserts rows, and updates/deletes rows using optimistic
row revisions. Rows have separate internal UUID and revision columns; user primary
keys are additional non-null unique constraints. Supported column types are text,
integer, decimal, boolean, timestamp, UUID, JSON/JSONB, text arrays and integer
arrays. Defaults are typed literals, generated UUIDs or current timestamps.
Integers and decimals cross this port as exact strings; SQL casts preserve them
without JavaScript floating-point conversion.

Definitions allow up to 100 columns and 32 policy rules. Identifiers use ASCII
letters followed by letters, digits or underscores, at most 63 characters; native
internal names are not user-controlled. Inputs are limited to 64 KiB per row,
definitions to 256 KiB, and returned pages to 2 MiB/1,000 rows. A native CHECK
constraint bounds the JSON representation of each row's column values to 64 KiB,
including values supplied by defaults. Statement and lock timeouts are five seconds.
The result-byte check runs after PostgreSQL decoding; this is not a streaming
result implementation.

## Foreign keys

A table can require that a column holds a value of another table's primary key.
In the schema this is a constraint of kind `foreign-key` with one column and the
referenced table's ID:

```json
{ "id": "...", "name": "order_customer", "kind": "foreign-key", "columns": ["customer"], "references": { "tableId": "..." } }
```

- The referenced table must be in the same environment and have a primary key.
  A table in another environment is reported as not found.
- The column's type must equal the key's type. JSON, array and boolean columns
  cannot be foreign keys. A table may reference itself.
- The column may be null, meaning "no reference".
- It is a native PostgreSQL foreign key with no cascading: a row cannot be
  inserted or updated to point at a key that does not exist, and a referenced
  row cannot be deleted or have its key changed. Both are refused as conflicts.
- Adding a foreign key to a table whose existing rows break it changes nothing.

**Impact across tables.** While any table references a table's primary key, that
key cannot be dropped, replaced, renamed or have its type changed. A schema
preview (`table.preview`) of such a change lists every referencing constraint as
`inbound-foreign-key:{tableId}:{constraintId}` in `dependencies` and sets
`blocked: true`; applying it is refused with a conflict until those foreign keys
are removed. Other changes to the referenced table, including renaming it, are
unaffected. Renaming the referencing column keeps the link.

A foreign key changed or dropped in PostgreSQL behind the catalog's back is
detected, like other managed constraints, before the next schema change.

PostgreSQL checks foreign keys without applying row policies. Someone who may
insert into a referencing table can therefore learn whether a key exists in the
referenced table, even if they cannot read that row.

## Native import execution primitive

`PostgresNativeTables.applyImport` accepts the shared `DataImportExecution`
component and returns `DataImportExecutionResult`. This trusted composition port
is used by [durable import jobs](data-imports.md); ordinary signed/account data requests
do not accept its `rows.import.apply` kind. Cloud's separate import API stages
encrypted input for leased dispatch, receipt reconciliation and cancellation.

Execution requires account authority with policy-preview identity, live
`data.write`, an active canonical binding and the current table revision. It
reuses the structural parser for all bounded source rows. Updates require
confirmation equal to the current table name. PostgreSQL evaluates defaults,
native types, full stored-row size, unique/check/foreign-key constraints and
native old/new row policies under the existing restricted role.

Conflict `error` performs inserts; `skip` ignores conflicts on the configured
user key; `update` performs native upserts on that key. Other constraint failures
remain failures. Upserts change only supplied non-key columns, preserve existing
internal row IDs and increment row revisions. Duplicate source keys are handled
in input order, and generated UUIDs identify new rows without exposing row IDs
in the result. Updating imports require applicable native insert/select/update
policies, including checks against a conflicting row owned by another user.

Atomic execution rolls back every row on failure. Partial execution uses a
savepoint per row for structural, native value/constraint and policy failures,
then commits successful rows and the result together. It reports total,
inserted/updated/skipped/failed counts and at most 100 safe row errors; counts
remain complete when error details are truncated. Unknown database failures,
statement timeouts, the cumulative DML work deadline or final authority loss
roll back the entire transaction even in partial mode. Statement/lock limits
remain five seconds; a 15-second DML budget is checked between and after statements.

The existing `canonical_data_commands` ledger and shared command advisory lock
commit the receipt with native rows and safe audit counts. Same-account retries
and concurrent execution return the original result without applying rows again;
changed command intent conflicts. Mapping-key order does not change the digest.
Receipts contain no row values. Role/scope state resets on pooled connections,
including after failed savepoints or final authorization rejection.

## Authority and execution boundary

`NativeDataAuthority` is a trusted composition port. Its caller must verify the
original signed request, bind principal/scope/binding, and supply a bounded live
authorization callback. This callback runs before work and again before commit;
a failed second check rolls back DDL, policies, rows and audit events. Configuration
requires account `resources.configure`; row operations require `data.read` or
`data.write`. App-user principals use their own user ID. Account policy previews
can choose a user ID or test public access, and record the preview mode/identity
in the audit event. Worker/operator/service-account principals are not supported
by this port yet. Audit events contain no row bodies or credential values.

Generated DML runs under the environment's non-superuser, non-bypass role with
transaction-local identity and search path; pooled state is reset at transaction
end. This adapter never accepts raw SQL. The administrative connection that sets
the role remains privileged, so exposing arbitrary SQL through it would break
the intended boundary. Signed transport and replay/idempotency middleware are now
implemented for account requests. A separate restricted SQL execution path,
failed-attempt auditing, application realm checks
and full administrative data access still need implementation. Legacy SQL and
realtime routes remain outside this native adapter and block production cutover.

## Verification

The native adapter also exposes scoped table summaries and definition/policy
details to account metadata authority. Summaries avoid fetching full definitions,
use a scope/UUID index and return exact keyset continuation state. Read authority
is checked both before and after retrieval, including in paused environments.
App identities cannot use this metadata port. The account-facing API encrypts
catalog cursors; see [account data](account-data.md).

```powershell
$env:CARBON_SERVICE_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55440/carbon_service_test'
bun test solutions/capabilities/cloud/data/tests products/carbon-database/tests/native-tables.integration.test.ts
```

The URL belongs only to the disposable loopback pgvector test service. Tests create
their own databases, provision two canonical environments with real lifecycle
repositories, and clean up only their databases and generated roles. A one-connection
pool exercises reset behavior. Tests verify two users and two environments, native
RLS flags, wrong/missing scope, owner transfers, native BEFORE-trigger checks,
public reads, disabled policies, pause/resume, optimistic revisions, reconstruction,
exact values/defaults, row-size constraints, and rollback after authority revocation.
Their authorization callbacks are controlled test ports; live signed data HTTP and
application-auth integration are not claimed by these tests.
