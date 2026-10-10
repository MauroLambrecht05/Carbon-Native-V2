# Legacy Database policy safety

The compatibility Database API previously accepted unknown policy expressions as
allow-all, evaluated UPDATE only against old rows, and cached policies indefinitely
inside each service process. These behaviors have been replaced while canonical
Database APIs and native PostgreSQL RLS are still being built.

## Policy behavior

Policy creation accepts only these exact expressions and the actions `SELECT`,
`INSERT`, `UPDATE`, `DELETE` or `ALL`:

| Expression | Meaning |
| --- | --- |
| `true` | Explicit allow for the named actions. |
| `false` | Explicit deny for this rule. |
| `auth.orgId == record.orgId` | Non-anonymous context with a matching organization ID. |
| `auth.userId == record.userId` | Non-anonymous context with a present matching user ID. |
| `record.is_public == true` | Boolean public flag is exactly true. |

Missing, empty or unsupported expressions are rejected before persistence.
Existing unsupported stored rules make policy-context access fail closed for the
table until those rules are removed or replaced. A `false` rule does not override
another applicable allow rule: supported rules combine with OR. No matching rule
denies access. Policy-context access also requires RLS to be explicitly enabled;
turning it off no longer opens the public PostgREST endpoint. Administrative
engine calls remain distinct from policy-context calls.

Policies are loaded inside the same transaction as the row operation. A shared
advisory lock covers that operation; policy changes take the corresponding
exclusive lock, keyed by project and table. Thus a policy change serializes after
an already authorized in-flight transaction, and subsequent transactions on all
service instances see the committed policy. There is no process-local policy
cache or asynchronous invalidation window. Policy deletion is scoped by project,
table and policy ID.
Table deletion uses the same exclusive lock and removes its policy/settings rows
in the DDL transaction. A replacement table cannot inherit old public policies;
if a dependency prevents the drop, both table and policy state remain intact.

SELECT checks existing rows. INSERT checks the actual returned row, including
defaults and BEFORE-trigger changes, before commit. UPDATE requires SELECT and
UPDATE access to existing rows and UPDATE access to actual proposed rows. DELETE
requires SELECT and DELETE access to existing rows. A failed proposed-row check
rolls back the entire operation. PostgREST array inserts now use one transaction
with a 1,000-row batch limit. Mutation notifications are emitted only after the
transaction commits; rolled-back changes do not enter the realtime engine.

## HTTP compatibility changes

Every legacy `/api/projects/{projectId}/...` route now verifies local project
ownership before dispatching to an engine or proxy. Authenticated PostgREST
requests also verify the selected project's owner. Worker credentials cannot act
as organization administrators. A supplied invalid token is rejected rather than
retried as an anonymous request. Anonymous PostgREST access still uses explicitly
enabled public policies.

The `projectId` query parameter selects routing scope and is no longer interpreted
as a row filter. Unknown filter operators are rejected. PATCH/DELETE currently
support equality filters; other operators are rejected instead of silently
discarded and broadening the mutation. PostgREST pages accept limits from 1 to
1,000 and nonnegative integer offsets.

## Verification and remaining work

```powershell
$env:CARBON_SERVICE_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55440/carbon_service_test'
bun test products/carbon-database
```

These credentials belong only to the isolated local pgvector test service.
The integration harness creates and drops only its own randomly named database.
Tests exercise real PostgreSQL transactions and product HTTP handlers: unsupported
and previously stored policies, multiple policy-engine instances, an observed
blocked advisory-lock writer, old/new ownership checks, trigger-modified rows,
atomic batches and multi-row updates, notifications after commit, foreign project
routes, worker/invalid tokens, and unsupported mutation filters.
Table-drop tests also verify dependency-failure rollback and safe recreation.

This is a compatibility-path correction, not completion of BE-03 or BE-08.
Canonical environment bindings, native RLS, restricted SQL execution, application
realm assertions, administrative access auditing and authorization of realtime
delivery remain required. Legacy raw SQL still runs through an administrative
connection: `search_path` does not prevent qualified cross-schema access. Query
filtering still fetches matching rows before application policy evaluation; native
predicate pushdown and resource limits remain part of the canonical data adapter.
The [PostgreSQL native policy model](https://www.postgresql.org/docs/16/sql-createpolicy.html)
provides separate existing-row and proposed-row checks for that implementation.
