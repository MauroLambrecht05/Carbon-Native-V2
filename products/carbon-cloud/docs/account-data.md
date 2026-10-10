# Account-facing data API

Cloud accepts authenticated POST requests at
`/platform/v1/orgs/{orgId}/projects/{projectId}/environments/{environmentId}/data`.
See [OpenAPI](account-data-api.openapi.json) for the shared request/response schemas.
This endpoint implements table catalog/detail/type reads, import structure review,
creation, schema edits, policy replacement, row queries and row insert/update/delete
through the real signed [Database protocol](signed-data.md).

Requests require the account session cookie, same-origin `Origin` and
`X-CSRF-Token`, including read queries. Cloud resolves the current organization,
project, environment and confirmed Database binding. The body cannot supply a
binding, service origin or principal. Cloud signs the outgoing request; Database
independently verifies it and calls Cloud for live authority. The browser cookie
is never forwarded. Network calls run after the local authority transaction ends.

## Table catalog and details

Send `{ "kind": "tables.list", "limit": 50 }` to list tables. The limit is 1–100,
default 50. Results contain `scope`, `tables` and an encrypted `nextCursor`; each
table summary contains stable `id`, current `revision`, `name`, `columnCount`
and `policiesEnabled`. Continue with the same limit, search/order and returned
cursor. The final page has no continuation cursor.

Optional `sort` accepts `id` (default), `-id`, `name` and `-name`; a leading minus
means descending. Names use fixed case-sensitive ASCII ordering, with UUID as a
tie-breaker. Optional `name` is a case-insensitive literal substring, up to 63
printable ASCII characters. Empty search matches all names. Spaces, `%` and `_`
are literal characters, without SQL wildcard or expression semantics. For example,
`{ "kind": "tables.list", "sort": "name", "name": "notes", "limit": 20 }`.

Send `{ "kind": "table.get", "tableId": "<uuid>" }` for `scope` and `table`,
including the current revision and full typed column/default/policy definition.
These operations require `metadata.read`, independently of row-read permission.
They require session and CSRF but do not require fresh authentication or mutation
headers. Metadata-only accounts can inspect definitions without reading rows.
Paused environments retain metadata access. Every response rechecks live authority.
Migration 0005 indexes canonical scope and table ID for bounded keyset reads.
Migration 0006 adds the corresponding fixed-collation name/UUID index. Substring
search scans the scoped catalog under the repository's statement timeout; the
name index supports ordering and continuation, not arbitrary substring lookup.
Catalog cursors have the same 15-minute expiry and authority/scope/page-size
bindings as row cursors and additionally bind operation kind, sort and normalized
search. Changing search case preserves its meaning; changing the filter or order
invalidates the cursor. Name continuations retain the original name and UUID
inside the encrypted cursor, so deleting or renaming the anchor does not require
looking it up. A table-list
cursor cannot be used for row queries or in another environment. Each page reads
current catalog data; concurrent creation/renaming does not provide a snapshot
guarantee and may move a table across the previously consumed boundary.

Row query and mutation requests require `access: { "mode": "policy-preview" }`, optionally with a
`userId`. This tests public or selected-user native policies and records the
preview identity in Database audit events. It does not create an app session or
bypass row policies. Application access remains unavailable through this route.

## Generated TypeScript types

Send `{ "kind": "table.types", "tableId": "<uuid>", "revision": "3" }` to obtain
`scope` and an `artifact` containing `tableId`, `revision`, `language: "typescript"`,
`filename`, `contentType: "text/plain"` and `text`. The optional revision pins the
requested schema; a changed revision returns 409. Omitting it uses the current
authorized definition. This is a metadata read with the same session, Origin,
CSRF, scope and live authority checks as `table.get`, without fresh authentication
or mutation headers. Responses are no-store and available in paused environments.

The source exports `carbonTable` identity/name/revision metadata, `CarbonJson`,
`CarbonRowValues`, `CarbonInsert`, `CarbonUpdate` and `CarbonRow<Columns>`.
Integers, decimals, UUIDs and timestamps use strings; integer arrays use string
elements to preserve exact values. Returned columns include their declared
nullability. Insert fields may be omitted when nullable or defaulted; update
fields are optional. The row envelope keeps internal `id` and `revision` separate
from `values`, and the generic column selection describes projections.

Source is deterministic for a table definition/revision and bounded to 65,536
characters. Fixed export names and quoted property names support legal columns
named like TypeScript keywords. Optional JavaScript prototype names use union
branches so an inherited property does not prevent omitting the own JSON field.
Default/check literals, row values and credentials are not emitted. These are
wire-shape declarations, not a runtime SDK: scalar formats, nonempty updates,
constraints and row policies remain server-validated. A generated artifact does
not establish application-realm authentication or grant data access.

## Import structure review

Send `rows.import-preview` with `tableId`, optional `revision`, and `input`:

```json
{
  "kind": "rows.import-preview",
  "tableId": "00000000-0000-4000-8000-000000000001",
  "revision": "3",
  "input": {
    "format": "json",
    "text": "[{\"body\":\"hello\",\"amount\":\"9007199254740993.12\"}]",
    "mapping": {},
    "conflict": "error",
    "atomic": true
  }
}
```

This metadata read requires session, Origin, CSRF and `metadata.read`. It loads
the authorized current definition and rechecks live authority; it does not need
fresh authentication, mutation headers or row-read/write permission. A supplied
stale revision returns 409. It reads no existing table rows and creates no data,
operation, receipt or audit event. It is also available while the environment is
paused. The asynchronous import command and worker are still unfinished.

`format` accepts `json` or `csv`. Source is bounded to 256 KiB UTF-8, 1,000 rows
and 100 distinct source columns. The complete request must still fit the 384 KiB
HTTP limit, including JSON escaping. Source names are distinct, nonempty, at most
128 characters and contain no control characters. `mapping` renames source fields
to native column names; an empty target explicitly drops a field. Unmapped fields
retain their names. Unknown mapping sources and duplicate target mappings fail
the request rather than discard data implicitly.

JSON source must be an array. Malformed syntax, duplicate keys (including escaped
spellings) and excessive nesting fail the request. Non-object rows produce row
errors. JSON integer/decimal values and integer-array elements must be exact
strings, matching the row API; numbers are never coerced into those types.

CSV accepts an optional leading BOM, comma delimiters, CRLF/LF/CR record endings,
quoted delimiters/newlines and doubled quotes. Quotes must surround a complete
field. Headers must be distinct; a row with a different field count is invalid.
Text, integer, decimal, UUID and timestamp cells retain their exact text. Booleans
accept `true` or `false`; JSON and array cells contain JSON. An unquoted `\N`
means SQL NULL, while quoted `"\N"` is literal text. JSON-encoded null also follows
the row API's null semantics. Empty text remains an empty string; an empty numeric
cell is invalid. Whitespace is not trimmed or silently normalized.

The response contains `scope` and `preview`: table identity/revision,
`validation: "structure"`, `total`, `valid`, `invalid`, up to 20 valid `samples`
and up to 100 row `errors`, plus `errorsTruncated`. Row numbers are one-based data
records, excluding CSV headers; only the first error for each invalid row is
reported. Errors contain safe categories and optional target column names, never
source value fragments. Samples contain mapped caller-supplied values. Nullable
and defaulted fields may be omitted; defaults are not evaluated or materialized.
Mapped rows are limited to 64 KiB before native storage conversion.

`conflict` accepts `error`, `skip` or `update`; skip/update requires a user primary
key. `atomic` describes the intended import behavior. Structure review does not
simulate either option, evaluate policies, check existing/batch uniqueness,
validate native check/foreign-key constraints, or prove native conversion and
stored-row-size feasibility. A structurally valid row may still fail at commit.
Bounded durable execution and its policy-bound commit checks use the separate
[import job API](data-imports.md). Staged large uploads and private export/download
jobs remain required work.

## Mutation concurrency and retries

`table.preview` takes `tableId` and a `change`, requires `metadata.read`, and returns
`scope` plus `preview` containing the current revision, proposed definition,
destructive flag and affected managed policy/primary-key references. It changes
no data and does not scan existing rows. Commit-time constraints, casts and native
dependencies can still reject a previewed change.

`table.alter` takes `commandId`, `tableId`, `revision`, `change`, and an optional
`confirmation`. Supported changes are:

| Change kind | Fields |
| --- | --- |
| `rename` | New logical table `name`; stable table/native resource IDs remain unchanged. |
| `column.add` | Complete typed `column` definition. |
| `column.edit` | `original` name and complete replacement `column` definition. |
| `column.drop` | Exact column `name`. |
| `primary-key` | New key `column`, or explicit `null` to clear the user key. |
| `constraint.set` | Complete managed `constraint`; the same constraint ID edits it. |
| `constraint.delete` | Exact `constraintId`. |

Managed constraints have a UUID `id`, logical identifier `name`, `kind` and 1–16
distinct `columns`. Up to 32 descriptors may be stored in a table definition.
Supported kinds are `unique`, `index` (ordinary PostgreSQL B-tree) and `check`.
Unique/index columns support the native types except `json`; `jsonb` is supported.
Native index limits still apply. A check has exactly one column and
`check: { "column": "amount", "operator": "gte", "value": "0" }`; supported
operators are `gte`, `lte`, and `ne`. Checks accept scalar typed values, with only
`ne` supported for booleans. Arbitrary SQL expressions and JSON/array checks are
not accepted. Nullable values follow PostgreSQL CHECK/UNIQUE semantics; choose
NOT NULL explicitly when null values must be rejected.

Creating a table may include its initial `constraints`. Later changes use the
same revisioned preview/alter protocol. Replacing a rule or removing a unique/check
constraint requires table-name confirmation. Removing an index or changing only
a constraint's display name does not. Display-name changes preserve native objects
and their references. Column renames update managed descriptors and native
signatures; columns with managed dependencies cannot be dropped first.

Migration 0007 stores private descriptor/signature records for managed objects.
Before a schema edit, the repository checks the records against both the table
definition and PostgreSQL. Missing, extra or changed managed state requires review.
It does not adopt arbitrary pre-existing constraints/indexes. Native DDL, private
records, public definition, audit and receipt share one transaction. Failed checks,
referenced constraint removal or authority loss restore the previous state.
This drift check runs for schema edits; it is not continuous database monitoring.
Foreign-key management and asynchronous/concurrent index builds remain unfinished.

Adding a user key validates uniqueness and sets the chosen column NOT NULL in the
same transaction. Replacing or clearing an existing key requires confirmation of
the current table name. Clearing the key preserves the column's NOT NULL setting;
change nullability explicitly if needed. The stable internal UUID remains the
physical primary key, so row IDs and row references do not change. The user key
is represented by a managed unique constraint plus NOT NULL.

New managed key constraints use table-specific stable names. Older canonical
tables with generated constraint names are supported only when one valid,
non-deferrable unique constraint exactly matches the catalog key and its NOT NULL
column. Missing or ambiguous matches require review. Referencing foreign keys
block replacement/removal; dependencies are never cascaded. Duplicate values,
null values or loss of authority roll back the native constraint, nullability,
metadata and receipt together. Preview describes the proposed key and required
nullability without claiming to validate existing rows or all native dependencies.

Column drops, type changes, constraint-rule replacements, integrity-constraint
removals and replacement/removal of an existing key require
`confirmation` equal to the current logical
table name. Edits use the provided nullability/default; omitting a default removes
it. Type conversion uses PostgreSQL casts and may change values; unsupported casts
or incompatible existing data reject the whole transaction. New NOT NULL columns
need valid defaults when rows exist. Tightening nullability checks existing rows.

Column renames update managed owner-policy and primary-key references. Drops with
those dependencies are rejected until they are removed. Native constraints/indexes
also block a column drop; there is no implicit cascade. Policy removal/recreation,
DDL, the full-row size check, metadata revision, safe audit event and command receipt
commit together. Failed DDL, size/nullability checks or a lost authority check roll
back all work. These commands retain the five-second statement/lock limits; large
schema migrations and asynchronous reviewed operations remain separate unfinished
work. Preview does not claim complete native dependency discovery.

All mutations require recent account authentication, a UUID `commandId`, an
identical `Idempotency-Key` header, and `If-Match`. Database's live authority
checks also require authentication to remain fresh before commit.

| Command | `If-Match` value |
| --- | --- |
| `table.create` | Current canonical environment revision |
| `table.policies` | Current table revision, identical to body `revision` |
| `table.alter` | Current table revision, identical to body `revision` |
| `row.insert` | Current table revision, identical to body `revision` |
| `row.update`, `row.delete` | Current row revision, identical to body `revision` |

Use the catalog environment detail to obtain the initial revision. Table creation
and policy replacement return the current table revision in their receipt. Row
queries and mutation receipts provide row revisions. A mismatched header/body
returns 400; a stale stored revision returns 409. Successful commands return
`{ "receipt": DataCommandReceipt }`, containing IDs and revisions without row
contents. Retrying the same command uses a new internal assertion and can recover
the durable receipt. Changed intent cannot reuse its ID; current authority and
the Cloud revision checks still apply to retries.

## Row pages

Send `kind: "rows.query"`, `tableId`, preview `access` and an optional `limit`
(1–1000, default 100). The result contains `scope`, `tableId`, `rows` and
`nextCursor`. Pass a non-null cursor in the next otherwise identical query.
Pagination defaults to native row UUID order. Cursors are encrypted and authenticated,
expire after 15 minutes, and bind session, permission revision, canonical scope,
binding, table, preview identity, page size and resolved authority revisions.
Changed or expired cursors return 400 and require restarting the list. Each page
rechecks current policies; pagination does not promise a database snapshot.

Optional `filters`, `columns` and `selectedIds` are also bound into the cursor.
They cannot change between pages. Filters combine with AND and with native row
policies; selected IDs never grant access to a hidden row. Up to 32 filters, 100
unique projected column names and 1000 unique selected UUIDs are accepted. Omitted
`columns` returns all user columns; an empty array returns only row ID/revision
with empty `values`. Omitted `selectedIds` selects all matching authorized rows;
an empty array selects none. Unknown columns are rejected. The serialized selection
is limited to 64 KiB and the result to 2 MiB.

Each filter contains `column`, `operator` and, except for `is-null`, `value`.
Optional `path` addresses a JSON/JSONB value using 1–16 parameterized path segments,
each 1–128 characters without NUL. No JSONPath expression language is executed.

| Operator | Semantics |
| --- | --- |
| `eq`, `ne` | Typed equality/inequality; JSON compares as JSONB and arrays as typed arrays. |
| `gt`, `lt` | Text, integer, decimal, timestamp or UUID comparison; JSON paths compare only string/number values of the supplied JSON type. |
| `contains` | Literal case-sensitive text substring, typed array containment, or JSONB containment. |
| `is-null` | No value field; matches SQL NULL, missing JSON paths and JSON null. |

`eq`/`ne` with null use the same null test or its inverse. Other comparisons with
non-null values exclude SQL NULL/missing paths. Numeric strings retain the column's
integer/decimal semantics; JSON numbers retain ordinary JSON semantics. `%` and `_`
remain literal in text containment. Unsupported operator/type combinations fail
validation. Filtering an unprojected column is allowed, while row policies still
evaluate the full row. Client validation rejects unexpected columns, unselected
IDs and duplicate rows in service responses.

Optional `sort: { "column": "amount", "direction": "asc" }` selects ascending
or descending typed column order. All ten column types are supported. Text and
text-array sorting use fixed `C` collation; JSON/JSONB use PostgreSQL JSONB order,
and other types use their PostgreSQL order without floating-point conversion of
integer/decimal strings. SQL NULL values sort last in both directions. Row UUID
ascending breaks ties, including between null rows. JSON null remains distinct
from SQL NULL. The sort column may be omitted from `columns`.

Sorted continuations retain the original typed sort value, SQL-null flag, row UUID
and table revision inside the encrypted cursor. Changing direction/column
invalidates the cursor. A changed table revision returns 409 and requires a new
query. Deleting or changing the anchor does not require re-reading its current
value. Concurrent row changes may move rows across the boundary; pages do not
provide snapshot isolation. The next cursor is absent on the final page, based
on an extra authorized lookahead row.

Row cursors accept up to 128 KiB of encoded text to accommodate a large unprojected
sort value. The account response exposes that value only within the encrypted
cursor. The service transport allows 2 MiB plus 80 KiB for the response, including
the internal continuation; returned row contents remain limited to 2 MiB. The
client checks continuation shape, table revision, projected boundary values and
duplicate IDs; it checks UUID ordering when no column sort is requested.

```json
{
  "kind": "rows.query",
  "tableId": "00000000-0000-4000-8000-000000000001",
  "access": { "mode": "policy-preview" },
  "filters": [{ "column": "amount", "operator": "gt", "value": "9007199254740993.12" }],
  "columns": ["amount"],
  "limit": 20
}
```

## Configuration and verification

Enable the account API and internal authority using the existing
[account](account-authentication.md) and [service](service-lifecycle.md) setup.
Set Cloud's `CARBON_DATA_DATABASE_ORIGIN` to the Database service origin and
configure `CARBON_PUBLIC_ORIGIN`, `CARBON_ASSERTION_KEY_ID`,
`CARBON_ASSERTION_KEY_NOT_BEFORE`, `CARBON_ASSERTION_KEY_NOT_AFTER` and
`CARBON_ASSERTION_PRIVATE_KEY`. The signing key must be active Ed25519; configure
its public key in the receiving trust bundle. HTTPS is required except for local
loopback HTTP. Omit the data origin to leave this capability unavailable (501).
There is no mock fallback. Bodies are limited to 384 KiB; responses are no-store.

The dedicated PostgreSQL integration command in [signed data](signed-data.md)
exercises the Cloud account handler and actual Database/authority HTTP transports.
It covers session/CSRF/origin rejection, revision checks, encrypted cursor reuse,
scope and preview changes, permission changes, fresh authentication, and rollback
of both native DDL and receipts when freshness expires before commit.

The production browser adapter, complete DataService catalog/schema/query
features, app realms, restricted SQL and remaining backend phases are still in
progress. This endpoint alone does not complete production cutover.
