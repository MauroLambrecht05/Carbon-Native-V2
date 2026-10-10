# Canonical relational data

`@carbon/data` provides the internal native-table repository for Database.
Definitions accept typed columns and explicit owner/public-read policies;
PostgreSQL enforces row visibility and proposed-row checks under each environment's
restricted role. The product composes this adapter as `deps.nativeTables`.

The persistence port requires a verified principal, exact canonical scope/binding
and live authorization callback. `ExecuteServiceData` verifies signed requests
before dispatch; `HttpDataClient` signs and validates the owning-service transport.
`AccountData` and `PostgresAccountDataAuthority` resolve browser account access,
canonical bindings, fresh mutation authority and encrypted query cursors in Cloud.
Table catalog and detail reads use separate metadata permission, bounded indexed
pagination, current definitions/policies and encrypted account cursors.
Generated TypeScript artifacts read the authorized current table revision and
describe exact wire values, nullability, insert defaults, updates and projections.
They remain metadata reads and include no row data or default/check literals.
Import structure review parses bounded JSON/CSV with explicit mappings and exact
typed values, using only the authorized schema and caller-supplied source. It
returns bounded samples/errors without simulating policies or native commits;
durable import and private export jobs remain unfinished.
The internal `applyImport` primitive now performs native policy-bound inserts,
skips and upserts with atomic/partial outcomes and durable retry receipts. It is
not accepted by ordinary account or signed data requests; queued execution and
lease/cancellation reconciliation still need wiring before API exposure.
Catalog search is a literal case-insensitive name substring; UUID/name ordering
supports both directions and preserves complete encrypted continuation boundaries.
Row queries support typed filters, JSON paths, projections and selected IDs under
native policies. Values remain SQL parameters; cursors bind the complete selection.
Typed row sorting uses nulls-last keyset pages, UUID tie-breaking and encrypted
revision-bound sort values, including values omitted from the projection.
Schema previews and atomic table/column edits preserve managed policy references,
rebuild row-size checks and commit revisions/audit/receipts with the native DDL.
User-key changes validate native uniqueness/nullability while retaining internal
row UUIDs and rejecting referenced or ambiguous constraints without cascading.
Managed unique/check constraints and B-tree indexes use persisted native signatures
to reject schema drift before edits and preserve atomic definition/audit/receipt updates.
Mutations commit durable safe receipts with native work. No customer SQL or
arbitrary policy expression is accepted. See
[native data implementation and limits](../../../../products/carbon-cloud/docs/native-data.md)
and [account API setup](../../../../products/carbon-cloud/docs/account-data.md)
for behavior, test coverage and remaining application-auth work.
