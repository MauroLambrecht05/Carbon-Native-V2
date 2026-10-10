# Slice 5: relational data and application authentication

Implemented against sections 10–11, the applicable developer recipes in 17.2,
and the Slice 5 boundary in 22.2 of the [frontend plan](platform-frontend-plan.md).
It extends the completed Slices 1–4. All operations remain local mocks; no
Database, Cloud, auth, email, OAuth, SDK, or native client is contacted.

## Routes and requirement coverage

| Area | Implemented behavior |
| --- | --- |
| `E/database/tables`, `E/database/tables/:tableId` | DATA-01–05/11: public-schema catalog, create table, supported typed columns/defaults, stable primary keys, scoped rows, structured filters including JSON paths, sort, column projection, pagination, JSON insertion/cell-merge editing, revision conflicts, exact selected-row deletion and atomic constraint enforcement. SQL NULL, missing values and empty text are distinct. Decimal values use normalized base-10 strings with exact comparisons. |
| Columns, relationships, indexes, settings tabs | DATA-08–10: add/change/rename/drop columns, supported conversions, dependency preview, unique/foreign-key/structured check constraints, tracked index creation, rename/drop/truncate table and primary-key definition. Unsupported conversion or dependent destructive changes explain the migration boundary; no implicit cascade occurs. |
| Import/export tabs and Rows commands | DATA-06/07: local CSV/JSON files, source-to-target mapping, validation preview, primary-key error/skip/update modes, atomic or partial import with per-row errors, tracked operations/cancellation and explicit download of selected/filtered snapshots. Export download rechecks current permissions and policy against full captured rows, even with projected output fields. |
| Policies tab | POLICY-01–05: enable/disable RLS, owner and explicit public-read rules, editable/deletable policy sets, identity/sample evaluation, matching-rule explanations and fail-closed unknown expressions. Updates check both existing and proposed row ownership. |
| API/types tab and `E/settings/api` | DATA-12, DEV-01/02 and the Slice 5 part of the backend schema recipe: schema-revision-derived types, local type download, public environment/realm configuration, hosted sign-in journey, owner-policy client console and least-privilege backend guidance. Examples identify proposed adapter contracts; they do not invent an exported Carbon SDK. Existing repository/CLI and release recipes link to completed slices. |
| `E/database/sql` | SQL-01–06: personal/project-shared saved queries with owner/revision checks, bounded fixture execution, explicit administrative/policy role, tracked progress, cancellation acknowledgement/too-late refusal, literal-redacted history, typed result snapshots, permissioned downloads and explicitly simulated explain output. |
| `E/auth/users`, `E/auth/users/:userId` | AUTH-04–07/09/14: create/invite, email/ID/status/provider/date filters, profiles and server-controlled claims, session counts/details/revocation, suspend/resume, explicit retained-orphan deletion and selected-field export operations. Creating an active identity does not verify its email. |
| `E/auth/providers`, `E/auth/settings` | AUTH-01/03/11: versioned signup/magic-link/OAuth configuration, exact redirect/callback validation, mock sender verification, TTL limits, optional explicit existing-session invalidation, secret-reference binding and verified-email linking policy. Email templates support validated variables, plain-text preview and local delivery. |
| `E/auth/events`, authorized realm inbox | AUTH-10: paginated sign-in/delivery/provider/session events with outcome, reason and correlation ID. Proofs are excluded from event/audit DTOs. The sensitive-data-permissioned mock inbox exposes one-use local callback links. |
| `/app-auth/:realmId/sign-in`, `/app-auth/:realmId/callback` | AUTH-02/08/13: public hosted sign-in fixture, email/OAuth success/denial/error, atomic one-use proof consumption, realm-isolated app sessions, independent sign-out/rotation, client-only profile edits and real policy-bound local row queries/writes. Carbon account and app sessions never replace each other. |
| Optional password provider | AUTH-12 is explicitly unavailable under provider capability v1. No password/reset behavior is claimed while password authentication is disabled. |

## Architecture and permission behavior

`data-contracts.ts` and `app-auth-contracts.ts` define typed browser ports for
the two domains. They reuse `Scope`, `RequestContext`, `Result`, pagination,
command options and operation receipts. Components call these ports through
the existing composition and scope-aware query cache.

`data-state.ts` is an additive schema-v1 extension containing normalized tables,
rows, queries, jobs, realms, users, sessions, challenges and events. It preserves
existing workspaces and canonical service bindings. Older fixtures may have
Database provisioned without Auth: explicitly enable Auth from environment
overview. Visiting an auth route never silently provisions a service.

`data-engine.ts` performs schema/row/policy validation and reconciles persisted
operation deadlines. Each commit uses a transaction draft; a refusal cannot
leave partially applied schema or row mutations. Partial imports commit only
the explicitly accepted rows. Generic operation controls cannot bypass the
data workflow's cancellation and authorization checks. Closing a progress view
does not cancel its operation. Failed work is reviewed and submitted as a new
operation; completed work is never automatically replayed.

Administrative queries and downloads require `data.read`; data mutations require
`data.write`; schema/provider configuration requires `resources.configure`.
Destructive schema/column operations also require data-write access. Schema
metadata alone does not grant customer rows or app-user data. Every scoped call
checks canonical tenancy and the current trusted dashboard principal. Receipt
replay rechecks access. Queued jobs recheck their original actor's current
session/permissions and production policy before committing. Downloads recheck
current access, including policy changes since snapshot creation.

App clients use a separate active session per realm. Suspended, deleted, expired
or revoked identities cannot rotate or write through their old sessions. App
identity input cannot grant dashboard authority or alter server-controlled
claims. RLS enabled without an applicable rule denies client access. Disabling
RLS explicitly grants verified realm clients table access; anonymous reads still
require a public-read rule. This mock rule set has no anonymous write rule.

Read auditing persists safe metadata without invalidating its own query.
Mutation events use the established invalidation stream. Forms reuse scoped
drafts, pending/idempotency handling and conflict feedback. Selected deletion
records retain their reviewed revisions rather than adopting later query
revisions. Clean forms refresh with changed resource revisions; dirty edits
retain their original revision for conflict review.

## Bounded SQL and configurable mock limits

Supported single-statement grammar (case-insensitive keywords, lowercase
identifiers; the LIMIT clause is optional):

```sql
SELECT * FROM notes LIMIT 100;
INSERT INTO notes DEFAULT VALUES;
UPDATE notes SET title = 'literal without quotes' WHERE id = 'uuid';
DELETE FROM notes WHERE id = 'uuid';
CREATE TABLE tasks (id uuid PRIMARY KEY, title text);
```

The CREATE fixture defines a UUID default and nullable title. INSERT still
validates required fields, defaults and policy. Unknown SQL fails with
`unsupported_operation`; it is never executed or reported as successful.
Results cap at 100 rows and report truncation. Explain and durations are
simulation output, not database measurements.

Other demonstration limits: 50 columns/table, 100 rows/page, 1 MB/1,000 rows per
import, 100 KB JSON values, ten-minute proofs, 5–43,200 minute app sessions and
20 exact redirect URLs. These are local simulation limits, not production policy.

## Functional walkthrough

1. Select Owner, open Acme North / Notes / development. In environment overview,
   enable Auth if its binding is absent and advance the mock clock five seconds.
   The existing `notes` table has separate Alice/Bob owner rows, and this fixture
   realm has email magic links enabled. Other realms start unconfigured.
2. Open Tables. Compare administrative rows with anonymous and named-user policy
   preview. Copy a user ID from App users. Insert an owned row, edit it, attempt
   ownership reassignment and inspect the denied result. Add a non-dependent
   column and inspect regenerated types and canonical row values.
3. Import a CSV/JSON fixture with a mix of valid and invalid rows. Review mapped
   errors; choose atomic refusal or partial commit. Advance three seconds and
   inspect operation results. Export a filtered/selected snapshot and download
   its local JSON. Changing policy can revoke access to a captured export.
4. Save a SQL query, execute a supported read, inspect history/results, and run
   an unknown statement to see explicit refusal. Pause the clock, queue another
   read, request cancellation, then advance time to acknowledge it.
5. Open hosted application sign-in from Providers. Request Alice's proof, open
   it from the authorized realm inbox and consume it once. The app console
   reads only Alice's rows. Reusing the proof fails without issuing another
   session. Try another owner in an update and observe denial.
6. Suspend Alice or revoke her sessions from App users. The app console loses
   access and rotation cannot resurrect the old session. Configure OAuth with
   an environment secret reference; inspect success/denial/error fixtures and
   explicit identity-linking policy. The secret cannot be removed while bound.
7. Switch to Developer/Viewer without sensitive-data grants: schema metadata
   remains available while row/user reads are forbidden. Production mutations
   require both permission and the environment confirmation. Scope switching
   removes the previous scope's cached results.

Deleting a user keeps an identity tombstone and owned rows. Email/profile/claims
are removed from the identity record; historical inbox and export snapshots
remain until local workspace reset. No automatic backup is created by schema
or data deletion. No live delivery, provider verification, database transaction,
or cryptographic session security is claimed by these local fixtures.

## Verification and handoff

Verification on 2026-09-07: browser TypeScript, mock production build, three
targeted data/auth checks and four existing configuration regression checks.
Critical checks cover proof reuse, realm isolation, owner reassignment denial,
suspension, schema visibility versus data grants, row conflicts, foreign-key
deletion rollback, partial imports, schema/type consistency, persistence,
unsupported SQL, cancellation, projection-aware export authorization,
production confirmation and revoked access on receipt replay. No full E2E or
visual-browser walkthrough is claimed. Build warnings are non-blocking TanStack
`use client` directives and the current shared bundle exceeding 500 KB.

Backend implementation belongs to Database data/schema/policy adapters and the
existing shared application-auth capability, with Cloud's canonical scope,
permissions, operations and audit contracts. Replace the mock's local proof and
session storage with secure delivery, provider callbacks and backend sessions;
implement restricted database roles, durable transaction/job/result storage,
server-enforced policies and actual schema/SQL semantics before HTTP integration.

Slice 6 now implements binary storage, vector/graph, realtime, migrations and
backup/restore; see [its handoff](platform-frontend-slice-6.md). Functions remain Slice 7.
