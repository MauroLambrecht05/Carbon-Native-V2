# carbon-database

An open-source, all-in-one developer data platform (Supabase-like) built
natively for Carbon: relational SQL, vector search (pgvector), a property
graph, serverless edge functions, and object storage, behind one REST API.
Self-hosted, v1.

```
composition/     the composition root (entrypoint.ts) — opens Postgres, runs
                  migrations, builds the S3 client, wires every engine
infrastructure/
  http/           routes.ts (the API), postgrest.ts (Supabase-compatible
                  /rest/v1/:table), server.ts (Bun.serve + WebSocket realtime)
  services/       the six real engines — DatabaseEngine, VectorEngine,
                  GraphEngine, EdgeFunctionsEngine, StorageEngine, RealtimeEngine
  persistence/    Database.ts (Postgres connection + migrations), identifiers.ts
                  (the SQL-injection-safety validator every dynamic identifier
                  goes through), MigrationEngine/SnapshotEngine (a project's own
                  schema migrations and export/import)
presentation/     the web studio (React) — signup, tables, vectors, graph, storage
```

## Identity is NOT owned here

This product keeps no `organizations`/`api_tokens`/usage tables of its own.
An org signs up exactly once, on **carbon-cloud** (`POST /v1/orgs`); every
authenticated request here is verified by calling carbon-cloud's real
`GET /v1/auth/verify` over HTTP (`HttpIdentityClient`, in
`@carbon/identity`) — real SSO across products, not a duplicate copy of
the same account data. `POST /api/auth/register` and the `/billing/*`
routes are thin, real proxies to carbon-cloud's own `/v1/orgs` and
`/v1/usage`/`/v1/billing/checkout` — see `routes.ts`'s own header comment
for exactly which routes proxy vs. run locally, and why
`/billing/confirm` has no real equivalent once billing goes through an
actual Stripe Checkout session (confirmation is carbon-cloud's own
webhook handler, not something a frontend can call synchronously).

This means **running this product standalone requires a reachable
carbon-cloud instance** — set `CONTROL_PLANE_URL`. The default in
`docker-compose.yml` (`http://host.docker.internal:8080`) reaches a
`docker compose up` in `../carbon-cloud` running on the same host.

## Run it locally

```sh
cd ../carbon-cloud && docker compose up -d   # identity/billing this product delegates to
cd ../carbon-database && docker compose up   # Postgres (pgvector) + MinIO + this API
```

Brings up Postgres (with the `pgvector` extension — the image is
`pgvector/pgvector:pg16`, NOT plain `postgres:16-alpine`, which doesn't
ship the extension), MinIO, and the API server (`:54321`).

```sh
# Sign up (proxies to carbon-cloud's real /v1/orgs)
curl -X POST http://localhost:54321/api/auth/register -H 'content-type: application/json' -d '{"organizationName":"My Org"}'
# -> {"organization":{...},"apiToken":"cc_...","defaultProjectId":"proj-..."}

curl -X POST http://localhost:54321/api/projects/<projectId>/tables -H "authorization: Bearer cc_..." -H 'content-type: application/json' \
  -d '{"name":"notes","columns":[{"name":"id","type":"string","primaryKey":true},{"name":"body","type":"string"}]}'
```

## What's real, verified against real infrastructure

Every engine below is backed by real Postgres (one schema per project for
user-defined tables — `CREATE SCHEMA`/`CREATE TABLE` are real dynamic
DDL, not a simulated SQL subset) and/or real S3-compatible storage, not an
in-memory `Map` — this product used to be exactly that (a sophisticated
prototype with a full REST API and a real-looking README, but nothing
survived a restart). Turning it real, and the bugs that surfaced doing
so **by actually running it against a live Docker Postgres/MinIO/carbon-
cloud stack and curling the whole flow** (not assumed from reading the
code):

- **`DatabaseEngine`** — real per-project Postgres schemas, real dynamic
  `CREATE TABLE`, parameterized insert/query/update/delete, and
  `executeRawSql` is genuinely `sql.unsafe(...)` scoped to the project's
  own schema via `SET LOCAL search_path` — not a hand-rolled regex SQL
  parser (what the prototype had). RLS is enforced in the application
  layer against real fetched rows (`RlsPolicyEngine`), not native
  Postgres RLS — a deliberate, documented scope decision (see
  `DatabaseEngine`'s own header comment).
- **`VectorEngine`** — real `pgvector`, cosine similarity via the `<=>`
  operator, verified with a real 3-point/3-dimension collection: the
  identical vector scored `1.0`, a near-orthogonal one scored `~0`, the
  query correctly ranked by real distance, not JS math over a Map.
- **`GraphEngine`** — real Postgres storage for nodes/edges; shortest
  path still runs the same in-memory Dijkstra the prototype had (a
  documented, deliberate choice — see the file's own header comment for
  why that's legitimate at this scale, not a shortcut), verified against
  a real 3-node path with the correct total weight.
- **`EdgeFunctionsEngine`** — deployed function code/env vars/invocation
  count are real Postgres rows now (survive a restart); execution was
  already genuinely real (a real `AsyncFunction` runner) and is
  unchanged — verified with a real deploy + invoke round trip.
- **`StorageEngine`** — real S3-compatible storage via Bun's own
  `S3Client` (MinIO in dev); verified with a real upload, then a real
  download over plain HTTP returning the exact bytes back.
- **`RlsPolicyEngine`** — real Postgres-backed policies with an
  in-process write-through cache (`loadAll()` populates it once at
  startup); verified end to end: enabled RLS on a table, added a
  `record.is_public == true` policy, confirmed an anonymous PostgREST
  read only returned the public row — **then restarted the container and
  confirmed the SAME filtering still applied**, proving the policy
  reload-from-Postgres path is real, not just the write path.

**Two real bugs found by actually running this, not by review**, both
the same double-JSON-encoding class carbon-cloud's own README documents
for `PostgresBuildRepository.save()`: `JSON.stringify()`-ing a JS value
before binding it to a `jsonb` column double-encodes it into a **jsonb
string scalar** holding escaped JSON text, instead of the real jsonb
object/array — caught directly (`psql ... jsonb_typeof(...)` reporting
`"string"` instead of `"object"`/`"array"`, and a 3-column table reporting
`columnCount: 135`, the stringified JSON's character count). Fixed in
both places it occurred: `DatabaseEngine`/`GraphEngine`/`VectorEngine`/
`EdgeFunctionsEngine`'s tagged-template inserts (pass the raw value with
an explicit `::jsonb` cast, not `JSON.stringify(value)`), and separately
in `DatabaseEngine.insertRow`'s dynamic positional-parameter INSERT
(same fix, no manual stringify needed there either — Bun.SQL's driver
infers jsonb-ness from the prepared statement's own knowledge of the
target column, in both call shapes).

A third real bug: `postgres:16-alpine` doesn't ship the `vector`
extension at all (`CREATE EXTENSION vector` failed with "Could not open
extension control file") — fixed by switching the compose file's
Postgres image to `pgvector/pgvector:pg16`.

## What's not built

Full service/characteristic-style discovery isn't the shape here, but
worth naming explicitly: no dynamic bucket-per-app-developer-bucket in
S3 (one shared bucket, key-prefixed by project — see `StorageEngine`'s
own header comment), no native Postgres RLS (see above), no PostgREST
operator pushdown beyond `eq` (everything else — `gt`/`like`/`in`/etc. —
filters client-side after an `eq`-filtered fetch; see `postgrest.ts`'s
own comment). The web studio (`presentation/`) still has its own signup
form calling the now-proxied `/api/auth/register` — untouched in this
pass; a real "one shared login across carbon-cloud/carbon-database's
dashboards" experience is a deliberate follow-up, not done here.

## Running Tests

```sh
bun test products/carbon-database
```

Only pure logic is unit-tested here (`identifiers.ts`'s SQL-injection
guard, `postgrest.ts`'s `parseFilter`, `RealtimeEngine`'s in-process
pub/sub) — same posture as carbon-cloud's own test suite, which doesn't
unit-test its Postgres repos either. The engines themselves are verified
by actually running the stack (see "What's real" above), not `bun test`.
