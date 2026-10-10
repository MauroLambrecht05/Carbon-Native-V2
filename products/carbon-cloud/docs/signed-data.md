# Signed Database data protocol

Database exposes twelve internal data operations through the existing opt-in
internal-platform composition. Shared platform schemas define columns, policies,
requests, receipts and scope-bound responses. See [data OpenAPI](data-api.openapi.json)
and [native persistence](native-data.md).

| POST suffix under `/internal/platform/v1/environments/{environmentId}/data/` | Permission |
| --- | --- |
| `tables.list`, `table.get` | `metadata.read` |
| `table.preview` | `metadata.read` |
| `table.types` | `metadata.read` |
| `rows.import-preview` | `metadata.read` |
| `table.create`, `table.policies` | `resources.configure` |
| `table.alter` | `resources.configure` |
| `rows.query` | `data.read` |
| `row.insert`, `row.update`, `row.delete` | `data.write` |

URLs require the exact query order `orgId`, `projectId`, `bindingId`, without extra
or duplicate keys. The `DataRequest` body repeats that scope/binding and contains
a command whose kind matches the path. Its assertion binds the Database audience,
account principal, scope, permission, exact POST path/query and body digest.
`X-Request-Id` must match the signed request. Bodies are limited to 384 KiB.
Responses identify scope/binding; query results also identify the table. They are
no-store, accept no browser-session authentication, and provide no browser CORS.
Native SQL diagnostics and row values never appear in error messages.

`table.types` generates a bounded TypeScript source artifact from the authorized
current table definition. An optional command revision rejects stale schemas.
The response retains table identity and revision, exact integer/decimal strings,
column nullability and insert-default optionality. It includes no row or default
literal values. See [account data](account-data.md) for declarations and limits.

`rows.import-preview` reviews caller-supplied JSON/CSV against the authorized
current schema, with optional revision pinning. It returns bounded structural
samples/errors and never reads existing rows or performs mutations. Mapping,
exact numeric/null semantics and format limits are documented in [account
data](account-data.md). Structural success does not prove policy, uniqueness or
native constraint acceptance. Bounded execution uses the separate
[lease-bound import protocol](data-imports.md); private exports remain unfinished.

Schema preview and atomic alteration support logical table rename, column
add/edit/drop and adding/replacing/clearing the user key. The [account API](account-data.md) specifies confirmation, complete
column definitions, managed dependency handling and commit-time validation.
Native DDL, policies, size checks, metadata, audit and receipt share a transaction.
Previews inspect managed definitions without scanning row data and are not a
guarantee that every cast or native dependency will permit the change.

User keys preserve internal row UUID identity and use managed UNIQUE plus NOT NULL
constraints. Key replacement/removal is restrictive: foreign-key references,
ambiguous native key state and failed data validation roll back the command.

Managed `unique`, `check` and B-tree `index` descriptors can be supplied at table
creation or through `constraint.set`/`constraint.delete` schema changes. The
private migration-0007 catalog retains descriptor and PostgreSQL signature evidence.
Schema edits reject drift and preserve constraint references on label-only changes.
Column renames update descriptors/signatures atomically. See the account API for
type/size bounds, confirmation and remaining foreign-key/asynchronous-build work.

`rows.query` accepts the bounded structured filters, projection and selected IDs
documented in [account data](account-data.md). Filter values and JSON paths are
SQL parameters, and queries still execute under native row policies. Cloud binds
the selection into encrypted cursors. PostgreSQL array parameters use explicit
element escaping for typed row values, selected UUIDs and JSON paths; commas,
braces, quotes, backslashes and the literal string `NULL` round-trip as values.

Sorted row requests accept `sort` (column plus asc/desc direction). Continuations
require `afterId` and `afterSort` together; the boundary contains the original
typed `value`, `sqlNull` flag and table `revision`. A non-final sorted page returns
`nextAfterId` and `nextSort`. Default UUID pages omit sort boundaries. SQL nulls
sort last, UUID ascending breaks ties, and table revision changes reject old
boundaries. JSON null is distinct from SQL NULL. Cloud encrypts these boundaries,
including sort values omitted from the row projection. See the account API for
type order, cursor size and concurrency semantics. Internal response bytes are
bounded to 2 MiB plus 80 KiB; row contents retain the 2 MiB bound.

Table lists return at most 100 summaries (default 50), ordered by stable UUID by default,
with a lookahead-derived continuation ID only when another result exists.
`sort` supports `id`, `-id`, `name`, `-name`; names use fixed ASCII ordering and
UUID tie-breaking. `name` filters by case-insensitive literal substring, with
printable ASCII input bounded to 63 characters. SQL wildcard characters remain
literal. Name sorts require `afterName` alongside `afterId` on continuation and
return `nextAfterName` alongside a non-null `nextAfterId`; ID sorts omit the name.
Cloud binds normalized search and order in its encrypted cursor. Both the native
repository and transport reject incomplete or mismatched continuation shapes.
`table.get` returns the current definition and revision. These reads require
account metadata authority and remain available while an environment is paused;
they neither query rows nor require fresh authentication. Cloud encrypts the
internal continuation ID before returning it through the account API.

Use the existing trust and `CARBON_AUTHORITY_ORIGIN` configuration from
[service lifecycle setup](service-lifecycle.md). Cloud now recognizes these exact
data paths and checks the current account session, permission revision, membership,
role, project assignment, MFA, lifecycle policy and confirmed Database binding.
Mutations additionally require the session's authentication to remain fresh.
It accepts exactly the operation-specific grant. The receiver independently checks
local ownership/native policies, consumes assertions durably and rechecks live
authority before committing. Unavailable authority denies work.

Only account assertions are currently enabled. Row operations use audited
`policy-preview` access, with an optional user ID; omitting it tests public rules.
App-user assertions remain denied until Cloud verifies their application realm
and session. Worker/operator identities cannot substitute for an account.

## Durable commands

Mutations require a UUID `commandId` and identical `Idempotency-Key` header.
Row insertion requires the current table revision in `revision`; policy changes
use the table revision, while row updates/deletes use the current row revision.
Queries must omit that header. Migration 0004 stores receipts by principal kind/ID
and command ID. The stable digest includes the validated business request, scope
and binding with object keys sorted. New assertion IDs, request IDs and session
rotation do not change the business intent. Changed intent cannot reuse the ID.

Command locking, native mutation, audit event and receipt commit in one transaction.
Concurrent duplicates return the existing receipt, including after response loss
and handler reconstruction. Receipts contain command/table IDs and optional row ID
and revision; they never store a copy of row contents. Retries still require current
authority and an available environment. Issue a fresh assertion for each transport
attempt: reusing the original proof is rejected as replay. Queries always reapply
current native policies. Authority loss before commit rolls back work and receipts,
allowing a subsequent authorized retry with the same command ID.

## Client and evidence

`HttpDataClient` signs requests for a pinned HTTPS Database origin, with loopback
HTTP allowed for local testing. It refuses redirects, uses a 20-second deadline,
bounds response bytes, and validates correlation, scope, binding, table/command/row
IDs and query pagination. Provider diagnostics become controlled errors. Its caller
supplies the currently resolved principal/role; Database independently rechecks
that authority with Cloud.

```powershell
$env:CARBON_SERVICE_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55440/carbon_service_test'
bun test ./.tools/automation/testing/platform-lifecycle.integration.test.ts
bun test solutions/capabilities/cloud/data/tests
```

The URL belongs only to the isolated loopback pgvector test service. The integration
harness uses real Cloud/Database HTTP servers, Ed25519 signatures, native PostgreSQL
policies, replay stores and command receipts. It checks dispatch through the actual
client, duplicate retries, response loss, redacted receipts, replay, wrong audience,
tampered bodies, stale permission revisions, ownership changes, deletion and
pre-commit revocation rollback. Client tests additionally reject foreign scope,
binding/table mismatches, inconsistent pagination, correlation errors, oversized
responses and provider diagnostics.

[Account-facing Cloud forwarding](account-data.md) now resolves the binding,
checks browser authentication/CSRF and supplies encrypted query cursors.
Application realm verification, the remaining
DataService catalog/schema/query features, restricted administrative SQL, failed
attempt auditing and production frontend integration remain unfinished. This is
an internal implementation milestone, not production cutover.
