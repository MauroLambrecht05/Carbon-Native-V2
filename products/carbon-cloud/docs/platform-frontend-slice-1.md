# Slice 1: contracts and mock foundation

Implemented against the complete [platform plan](platform-frontend-plan.md), sections 4–6, 19–20 and 22.2. This document describes the implemented contract, not backend support. Slices 2–10 remain pending.

## Run and verify

From the repository root (use `bun.cmd` on Windows if PowerShell script execution is disabled):

```sh
bun install --cwd .config
bun run --cwd products/carbon-cloud dev:mock
bun run --cwd products/carbon-cloud typecheck:browser
bun run --cwd products/carbon-cloud test:browser
bun run --cwd products/carbon-cloud check:mock-assets
bun run --cwd products/carbon-cloud build:mock
bun run --cwd products/carbon-cloud preview:mock
```

Dev and preview both use `http://127.0.0.1:5175`; run only one at a time. Development changes require a manual page reload: the hot-reload client is excluded to keep browser subscriptions entirely local. Build output is `products/carbon-cloud/dist-mock/`, including a root `index.html`. A static host must rewrite application deep links to this file. No server, database, object store, worker, provider credentials, or service environment variables are needed.

The old `presentation/src` dashboard has been removed. The existing API's `/` now explains the separate frontend command, and `/dashboard.js` returns 410. Its `/v1/*` behavior is unchanged. This small asset-serving change prevents API startup from importing or bundling the mock browser. Existing tokens in a previous origin's localStorage are neither read nor reused.

## Architecture and conventions

| Concern | Implemented choice |
|---|---|
| Composition | `composition/browser.tsx` mounts React once; `create-browser-services.ts` wires only mock adapters and IndexedDB |
| Browser boundary | Independent `presentation/tsconfig.json`, DOM/JSX types, no Bun types; backend tsconfig excludes browser sources |
| Dependencies | Existing React 18, Router 6 and Vite 5; TanStack Query 5 is the single resource cache |
| UI ownership | Provider/router/query/operation plumbing under `presentation/framework`; fixture console under `features/foundation`; development controls under `devtools` |
| Ports | `presentation/framework/services/contracts.ts`; async `Promise<Result<T>>` for every service operation; `unwrap` converts failures only at the query/mutation boundary |
| Identifiers | Opaque strings; mocks allocate persisted, deterministic prefix/counter IDs. Pages never infer scope or type from an ID. Names can change independently |
| Scope | Cloud organization → project → environment; adapters validate every relationship and active principal. Account requests do not invent an org ID |
| Revisions | Opaque strings; mock `rN` increments on transitions. Mutable operation commands require an exact expected revision |
| Serialization | UTC ISO dates; decimals/bigints reserved as decimal strings. DTOs are readonly snapshots and copied across persistence boundaries |
| Errors | Closed code union with message/request ID, optional field errors and retry delay; persistence problems return `unavailable`, with no memory fallback |
| Lists | Cursor pagination, stable name/ID sorting, ID tie-breaker, structured name filter; page sizes 1–100. Cursors bind to visibility/scope/filter/sort/page size; stale cursors require restarting |
| Cache | Keys include session visibility epoch, org/project/environment, resource and URL query parameters. Navigation cancels and removes old scope queries. Revocation/sign-out/expiry clears the session's cache before new content renders |
| Persistence | Schema-v1 normalized collections in the `carbon-cloud-mock-v1` IndexedDB workspace. One readwrite transaction commits a synchronous draft; exceptions abort the whole change |
| Multiple tabs | IndexedDB serializes transactions across tabs. BroadcastChannel sends invalidation metadata only; receivers reread persisted records. A 500 ms reconciliation poll also works without BroadcastChannel |
| Clock | Persisted virtual-time/wall-time anchors, paused state and deadlines. Reload reconciles all elapsed steps; paused time does not advance on reload |
| Events | Post-commit, deterministic increasing cursors; scoped replay/deduplication, explicit gap on cursor beyond retained history, unsubscribe and authorization reevaluation |
| Mode | Separate `dev:mock`, `build:mock`, `preview:mock` commands. No HTTP adapter or fallback. CSP disallows connect requests, forms to external destinations, objects and external scripts. Build graph rejects server/native composition |

Frontend DTOs remain product-owned because no backend/CLI consumes them yet. Promote a subject to `solutions/contracts` with a compatibility policy when it becomes shared; extend existing Cloud/Database/Registry capabilities for real behavior. A future real browser composition must exclude the mock entry, store, scenarios and tools entirely. A minified `build:mock` remains a mock artifact and must never be represented as the production service adapter build.

The query-cache integration follows the [TanStack Query provider contract](https://tanstack.com/query/latest/docs/framework/react/reference/functions/QueryClientProvider) and [cancellation contract](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation). No form/schema framework was needed for the foundation controls; adapters enforce their bounded inputs. DTO validation for future HTTP payloads is still an integration requirement, not a type assertion substitute.

## Implemented routes and ports

The complete section-5 route catalog is registered with audience, label and owning slice. Unknown paths are not-found. Planned routes display explicit capability limits after applicable session/scope guards; this does **not** constitute implementation of later stories or authorization to nonexistent detail resources.

Functional foundation routes are `/`, `/organizations`, organization `/overview` and `/projects`, project `/overview`, and environment `/overview`. `/sign-in` hosts the fixture-entry explanation; it is not ID-02 authentication. The additional environment `/foundation/operations/:operationId` is a diagnostic mock route, not a new product feature. Organization/project/environment creation remains Slice 2. Public app-auth routes never establish a dashboard session; operator routes require an independent audience and expose no customer data.

| Port | Operations now implemented | Authorization and behavior |
|---|---|---|
| Session | `getSession`, `signOut`, `subscribe` | Session comes from adapter state; fake identities only. Visibility epochs change on selection, revocation, expiry and reset |
| Catalog | `listOrganizations`, `resolveScope`, `listProjects`, `listEnvironments` | Active dashboard audience, membership, project assignment, correct ancestry; foreign resources return not-found; known denied actions return forbidden |
| Capability | `getAvailableCapabilities` | Authorized scope; foundation enabled, later features unavailable. Windows x64, NSIS and optional WiX are metadata limits only |
| Operation | `get`, `list`, `requestCancel`, `retryAllowedStep` | Scoped metadata access for reads; configuration permission for commands; original operation scope is rechecked even when queried through an org |
| Activity | `listAudit` | Separate audit permission; safe actor/action/resource/result/time/request metadata only |
| Events | `subscribe` | Scoped metadata access on entry and every delivery; returns unsubscribe; revoked or switched identity closes subscription |
| Mock tools | identity/clock/latency/reset/failure controls, `startCheck` | Separate injected development port. Start check still validates permissions and idempotency in the adapter |

## Stateful demonstration

Fixtures: visitor, verified account with no orgs, owner of two tenants, restricted developer, viewer, billing-only member, independent operator, wrong-audience app user and worker. Each tenant has Notes and Desk projects with development/staging/production and distinct canonical service bindings. Restricted users cannot discover other assignments through aggregate bindings, operations or events. This is the foundation subset of section 20.3; later resource fixtures arrive with their owning slices.

`foundation.check` is a three-step local diagnostic (Cloud, Database, Registry fixture checks). It creates no real resources and makes no cross-service transaction claim. It exists to exercise the operation plumbing before product workflows use it.

- Start returns a queued operation, persists deadlines, records activity, then emits a committed event.
- The scheduler advances queued → running → succeeded, or stops at a deterministic failed step while retaining earlier completions.
- Queued cancellation is immediately terminal; running cancellation becomes cancel-requested and then cancelled. A completed operation wins an already-completed race; stale revisions return conflict.
- Retry of a failed step requires the latest revision, retains the original operation ID/completed checks and schedules remaining steps. Each retry request has a new idempotency key.
- Idempotency binds actor, canonical scope, command and key to the payload/revision. Same input returns the original result; different input conflicts. Permission is rechecked before replay.
- Named one-shot errors apply to scope queries or operation submission. A separate lost-response control commits a command and then returns unavailable; resubmitting the same input/key recovers its original operation. Never automatically replay a mutation.
- Successful transitions and known-scope command refusals create safe audit records. Foreign-scope refusals do not disclose or attribute a private resource. Mock setup controls are development configuration, not customer commands; membership-revocation tooling is explicitly attributed to the mock tool.

Pause/advance time, inject failures, simulate a lost response, revoke restricted membership, and reset through the visible mock panel. Removing the last owner is refused even in the revocation demonstration. Reset requires typing `RESET MOCK` and replaces only this fake workspace across tabs. Incompatible/corrupt persistence exposes a recovery screen and requires explicit reset; it is not silently reseeded. No production retention, pricing, session lifetime, or SLA follows from fixture values.

## Functional review

1. Open the frontend and select the owner fixture. Follow North → Notes → development. Open South and confirm different IDs despite the same project name. Reload a deep link.
2. Pause the clock. Run a fixture check, advance ten seconds and inspect steps/events/audit. Reload and observe the same operation. Reuse its idempotency key, then change the outcome with that key to observe conflict.
3. Use a new key with the partial-failure outcome. Advance time, retry the failed step, then advance again. Use another key to check queued/running cancellation.
4. Arm lost-response injection, submit, and recover with the same key. Arm an unavailable scope query and refetch visible context; use Reload to recover.
5. Choose the restricted developer. North/Notes metadata is visible; South and North/Desk are not. Production configuration and customer-data access remain denied. Revoke this membership while its stream is connected; content disappears.
6. Choose billing: organization context is available without project metadata. Choose an operator/app user/worker and verify customer routes are forbidden. Choose the empty-account fixture or visitor for empty/unauthenticated states.
7. Advance one hour to expire the fake session; resource projections are cleared. Reset explicitly to restore the deterministic seed.
8. Open two tabs on the same origin. Submit identical operation keys concurrently, advance time in either tab, and verify one operation with one terminal transition.

Automated verification uses focused Bun contract tests, `fake-indexeddb` transaction tests, and React component integration tests. These cover tenant/audience/grant denial, copying, cursor binding, cancellation, partial retry, lost-response recovery, reload reconciliation, cross-coordinator idempotency, rollback/schema errors, and cache removal on navigation/revocation/expiry. Existing Cloud route tests also remain green. A real-browser visual walkthrough could not be run in the implementation environment because the browser-control tool reported no available browser; these checks do not assert pixel layout or browser-engine-specific IndexedDB behavior.

Verification on 2026-09-06: browser TypeScript check passed; 59 tests passed (24 foundation/presentation and 35 existing API tests); mock production build passed; root and deep-link preview requests returned the same entry with `connect-src 'none'`; the temporary development asset check passed for HTML, JavaScript and plain CSS without a hot-reload client. Vite reports non-blocking warnings about TanStack Query's ignored `use client` directives in this client-only bundle. No backend/API integration was exercised by the frontend checks.

## Backend handoff and decisions

No implemented mock operation maps to a newly implemented HTTP endpoint. Real identity/catalog authorization needs BE-01/02/03; durable operation/audit/event transport needs BE-11. Billing, provider, build, data, Registry and runtime changes remain in their planned slices/backlogs. The existing app-auth authority remains `solutions/capabilities/cloud/auth`; no duplicate identity system or new service was added.

No user decision blocks Slice 1. The conventions above are implementation choices; the following still require deliberate product decisions before production rather than invented defaults:

- Real identity provider configuration, terms version/text, MFA/recovery policy and production session/security limits (Slice 2).
- Production-action approval policy and any stricter customer-data restrictions on admin presets (Slices 2–5).
- Commercial prices, additional quotas, downgrade/grace and budget enforcement rules (Slice 9).
- Retention/legal/deletion obligations for releases, packages, invoices, backups and audit; service-account ownership on member departure (relevant lifecycle slices).
- Namespaced Registry identity ↔ existing local slug/CLI mapping, and supported updater payload/rollback/withdrawal/trust interoperability (Slices 4 and 8).

The planning defaults in section 22.5 remain in force. Region selection, forced client execution, complete SQL support, external embedding generation, and production retention guarantees have not been introduced.
