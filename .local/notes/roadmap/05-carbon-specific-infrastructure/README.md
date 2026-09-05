# Carbon-specific SDK tier — what has to exist first

`.local/notes/carbon-sdk-capabilities.md`'s "Carbon-specific" section lists ~40
`carbon-<word>` capabilities. As of 2026-09-04, four of them (carbon-manifest,
carbon-runtime, carbon-framecache, carbon-snapshot) are local, real, and were
built directly as carbon-sdk plugins. Five more (carbon-identity, carbon-auth,
carbon-billing, carbon-orchestration, carbon-worker) have real client+server
code today, but only against a self-hosted instance — no Carbon-operated
server exists, so they were deliberately left un-wrapped for now. The
remaining ~28 have **no backend at all**, not even self-hosted.

This document is the build order for that backend — what has to exist, in
what sequence, before each remaining SDK plugin would be anything more than a
client calling a URL that doesn't respond. It does not itself build any of
this; it's the plan a future session works through.

## Where this lives

Every one of these already-real services (`solutions/capabilities/cloud/
{identity,billing,orchestration,worker}`) follows the same shape: a clean-
architecture bounded context (`application/{ports,usecases}`, `domain/
{entities,value-objects}`, `infrastructure`, `tests`) wired into one running
server, `products/carbon-cloud` — a single Bun/TS control-plane process
(`products/carbon-cloud/infrastructure/http/routes.ts`, deployed via
`composition/docker/control-plane.Dockerfile`) backed by one Postgres
instance (`infrastructure/persistence/migrations/*.sql`, currently
`0001_init` builds, `0002_identity` orgs/tokens, `0003_billing` usage/plans),
plus separate worker containers (`worker-linux.Dockerfile`, `worker-
windows.Dockerfile`) that claim build jobs from it. This whole stack has a
real, working `docker compose up` (`products/carbon-cloud/docker-compose.yml`
— Postgres, MinIO, control-plane, one Linux worker) and was verified end to
end for real per that product's own README: real org signup, real worker
token, a real git clone + `cargo build --release` + `.deb` package + upload,
downloaded back over plain HTTP with a matching sha256.

This same internal shape (a `solutions/capabilities/cloud/<name>/` bounded
context per concern, wired into one product's HTTP routes) is what every
NEW product below reuses too — only the "one process, one Postgres" part is
product-scoped now rather than repo-wide: a capability assigned to
`carbon-cloud` adds its context under `solutions/capabilities/cloud/`, a
migration to `carbon-cloud`'s own migrations directory, and routes to
`carbon-cloud`'s own `routes.ts`; a capability assigned to `carbon-compute`
does the identical three things inside `carbon-compute` once that product
exists. The existing `HttpControlPlaneClient` request/response shape
(`solutions/capabilities/cloud/worker/infrastructure/HttpControlPlaneClient.ts`)
is the template every cross-product client wrapper copies — e.g. carbon-ai
calling into carbon-cloud's billing API to meter usage.

**Correction to earlier language in this doc, and the resulting architecture
decision (2026-09-04):** `products/carbon-database` and `products/
carbon-registry` ALREADY EXIST as separate products, with substantial code
and READMEs that read as if they already cover carbon-database/carbon-
vector/carbon-storage (carbon-database) and carbon-registry (carbon-
registry). They don't, in the sense that matters here: every engine in
`carbon-database/infrastructure/services/` (`DatabaseEngine`, `VectorEngine`,
`GraphEngine`, `RealtimeEngine`, `RlsPolicyEngine`, `StorageEngine`, ...) is
backed by an in-memory `Map`, not Postgres or disk — nothing survives a
process restart, and there is no `docker-compose.yml` for it at all. Same for
`carbon-registry/infrastructure/services/RegistryEngine.ts`. These are real
prototypes of the API surface, not real hosted infrastructure — do not treat
their existence as "carbon-database is done" when scoping work below.

Decided: **contained microservices, not one growing monolith.** Earlier
language in this doc proposed folding every new capability into
`carbon-cloud`'s single control-plane process as more bounded contexts and
more routes on one HTTP server. That's wrong at this scale — ~28 capabilities
across identity/data/compute/AI/comms/observability/growth/commerce/
collaboration/delivery/registry is genuinely "a lot of different things
working together over multiple levels and products," and belongs organized
as multiple independently-deployable products, each with its own real
persistence and its own `docker-compose.yml` (the same shape `carbon-cloud`'s
already has), composed together for local dev rather than merged into one
process. See "Service map" below for the concrete product boundaries this
implies, replacing the single-process framing above.

**Filesystem location — no new top-level folder.** Every product below,
new or existing, lives at `products/<name>/` — the repo's only three
top-level folders are `products/`, `solutions/`, and `labs/`, and
`products/README.md` already defines `products/` as exactly this ("Shipping
deliverables. One directory per product"), with `carbon-cloud`/`carbon-
database`/`carbon-registry` already there as precedent. `carbon-database`
and `carbon-registry` are NOT moved anywhere — they get real persistence
added in place. Each new product (`carbon-compute`, `carbon-ai`, `carbon-
comms`, `carbon-observability`, `carbon-growth`, `carbon-collab`, `carbon-
cdn`) is scaffolded fresh at `products/<name>/` with the identical shape
`carbon-cloud` already has (`README.md`, `package.json`, `main.ts`,
`composition/`, `infrastructure/`, `presentation/`, `docker-compose.yml`).
What DOES move/live elsewhere is business logic, per `products/README.md`'s
own layering rule (no `domain/`/`application/` inside `products/`): each
product's capability logic is a `solutions/capabilities/cloud/<name>/`
bounded context that the product's `composition/` wires up and its
`infrastructure/http/routes.ts` exposes — the product folder itself stays
thin (composition + presentation only), same as every product in this repo.

**Important existing-scope correction:** `carbon-orchestration`/`carbon-
worker` today are Carbon's own **build pipeline** (`builds` table — claim a
build job, run it, report status) — not a general job queue for an app's own
background compute. Turning them into the latter (what the capability
catalog's descriptions imply) is itself new scope, phase 3 below, not
something to wrap as-is.

Once a real Carbon-operated instance of `products/carbon-cloud` exists at a
stable URL, that becomes the default `controlPlaneUrl` these plugins point
at; until then, every one of them requires the app's own developer to run
their own instance (`carbon.toml [cloud] controlPlaneUrl = "..."`).

## Service map

Each row is one independently-deployable product: its own `main.ts`/
`composition/`, own Postgres database (or its own schema in a shared
instance, product's choice), own `docker-compose.yml`. Capabilities are
grouped by product where they're either already scaffolded together
(carbon-database's engines), share the same auth/token infra (carbon-cloud),
or are small enough that a dedicated product per capability would be pure
operational overhead — not because "microservice" means one process per
catalog row. Splitting further later (e.g. carbon-ai out of carbon-compute)
is a cheap move if a group outgrows sharing a process; starting there isn't
free.

| Product | Status | Owns | Persistence |
|---|---|---|---|
| `carbon-cloud` | **real, working** | carbon-identity, carbon-auth (worker-token slice; end-user auth is new work here), carbon-billing, carbon-payments (generalizes the same Stripe plumbing), carbon-orchestration, carbon-worker (build pipeline; generalizing to arbitrary jobs is new work here) | Postgres + MinIO (existing `docker-compose.yml`) |
| `carbon-database` | **exists, prototype only — needs real persistence** | carbon-database, carbon-storage, carbon-realtime, carbon-search, carbon-vector, carbon-migrations, carbon-backup — maps almost directly onto its existing `DatabaseEngine`/`StorageEngine`/`RealtimeEngine`/`RlsPolicyEngine`/`VectorEngine`/`GraphEngine` | Needs: Postgres (replaces the in-memory `Map`s) + S3-compatible storage (MinIO in dev) + a new `docker-compose.yml` |
| `carbon-registry` | **exists, prototype only — needs real persistence** | carbon-registry, carbon-trust (wiring the already-real signing/verify tools from `solutions/capabilities/plugin/trust` into this product's publish route) | Needs: Postgres (replaces `RegistryEngine`'s in-memory `Map`) + S3-compatible storage for tarballs + a new `docker-compose.yml` |
| `carbon-compute` (new) | not built | carbon-functions, carbon-queue, carbon-cron, carbon-edge | Postgres (job state) + a queue backend (Redis, or Postgres `LISTEN/NOTIFY` to start) |
| `carbon-ai` (new) | not built | carbon-ai | Stateless proxy; meters through carbon-cloud's billing API, no DB of its own beyond a request log |
| `carbon-comms` (new) | not built | carbon-email, carbon-sms, carbon-webhooks, carbon-push | Postgres (send/delivery log) + depends on carbon-compute's queue for retry/backoff |
| `carbon-observability` (new) | not built | carbon-logs, carbon-monitoring, carbon-analytics | Postgres or a time-series store (start with Postgres, revisit if volume demands it) |
| `carbon-growth` (new) | not built | carbon-flags, carbon-status | Postgres; carbon-flags pushes updates over carbon-database's realtime channel rather than building a second one |
| `carbon-collab` (new) | not built | carbon-teams (extends carbon-identity's org model via carbon-cloud's API), carbon-support | Postgres |
| `carbon-cdn` (new) | not built | carbon-cdn, carbon-domains | Edge/cache config + DNS provider API; depends on carbon-database (storage) and carbon-comms (webhook endpoints need a real domain) |

**Local dev, all services:** each product keeps its own standalone
`docker-compose.yml` (so a session only touching build/release work never
has to bring up carbon-database's containers). A root-level compose file
using the Compose spec's `include:` directive to pull in every product's own
`docker-compose.yml` is the way to bring up the full stack at once when
working across products — not written yet; add it once a second product
(carbon-database) actually has a real compose file to include.

## Build order

Each phase lists what to build, then which catalog plugins it unblocks.
Phases are ordered by hard dependency, not by importance — a phase's
services need the identity/data-plane pieces before them to mean anything
(who is this data scoped to; where does it actually get stored).

### Phase 0 — already real, self-hosted only (not wrapped as SDK plugins yet)

- **carbon-identity** — org/developer accounts, API tokens
  (`solutions/capabilities/cloud/identity`, `0002_identity.sql`).
- **carbon-auth** (worker-token issue/verify slice) — `IssueWorkerTokenUseCase`/
  `VerifyTokenUseCase`. Not yet a general end-user auth service (magic
  links/OAuth for an app's OWN customers, as the catalog describes) — that's
  new scope, folded into phase 1.
- **carbon-billing** — real Stripe Checkout integration
  (`billing/infrastructure/StripeCheckoutProvider.ts`) plus `usage_records`/
  `org_plans` tables. Metering exists; a full self-serve plan/subscription
  UI does not.
- **carbon-orchestration** / **carbon-worker** — real build-claim protocol
  (`FOR UPDATE SKIP LOCKED` over `builds`), real HTTP client. Scoped to
  Carbon's own build pipeline today (see correction above).

**Depends on:** nothing further — these are the foundation everything else
authenticates and bills against.

### Phase 1 — end-user identity, data, and files

The plane every later phase stores its rows in or authenticates its callers
against.

1. **carbon-auth**, extended — magic-link/OAuth sign-in and session issuance
   for an app's OWN end users (distinct from carbon-identity's
   developer/org accounts). New `end_users`/`sessions` tables, new
   `solutions/capabilities/cloud/auth` bounded context.
2. **carbon-database** — provisions an isolated Postgres schema (or
   database) per app, exposes row-level policies, and is itself the
   thing every phase-2+ service's tables live in from here on.
3. **carbon-storage** — an S3-compatible bucket per app plus signed-URL
   issuance (MinIO or a real S3-compatible provider behind the control
   plane, not reinvented object storage).

**Depends on:** Phase 0 (org scoping — every database/bucket/end-user
belongs to an org).
**Unblocks:** carbon-auth, carbon-database, carbon-storage directly, and is
a hard prerequisite for every plugin in phases 2, 3, 5, 6, 7, 9 below.

### Phase 2 — built directly on carbon-database / carbon-storage

4. **carbon-migrations** — versioned schema migration/rollback tooling
   scoped to an app's own carbon-database instance.
5. **carbon-realtime** — a WAL/logical-replication listener over
   carbon-database rows, fanned out to app clients over a managed socket.
6. **carbon-search** — full-text indexing over carbon-database tables
   (Postgres `tsvector`, or an attached index) — no separate cluster to
   run.
7. **carbon-vector** — pgvector (or a dedicated vector store) alongside
   carbon-database, for embeddings/semantic search.
8. **carbon-backup** — snapshot and point-in-time restore across
   carbon-database + carbon-storage together.

**Depends on:** Phase 1 (carbon-database, carbon-storage).
**Unblocks:** carbon-migrations, carbon-realtime, carbon-search,
carbon-vector, carbon-backup.

### Phase 3 — compute plane

9. **carbon-functions** — HTTP-triggered serverless functions, deployed
   through the SAME build/claim pipeline carbon-orchestration/carbon-worker
   already run for Carbon's own builds, generalized to run an app's
   function code instead of only Carbon's own binary builds.
10. **carbon-queue** — a managed message queue; also the retry backbone
    phase-5's carbon-webhooks needs.
11. **carbon-cron** — scheduled/recurring dispatch into carbon-queue /
    carbon-worker, no always-on process required.
12. **carbon-worker**, generalized — extend the existing build-claim
    protocol to arbitrary app-submitted background jobs, not just builds.
13. **carbon-edge** — an edge-deployed variant of carbon-functions,
    latency-scoped rather than regional.

**Depends on:** Phase 1 (identity + database for job/function state),
Phase 0's existing build-claim protocol (extended, not replaced).
**Unblocks:** carbon-functions, carbon-queue, carbon-cron, carbon-worker
(general form), carbon-edge, and is a prerequisite for carbon-ai (phase 4)
and carbon-webhooks (phase 5).

### Phase 4 — AI

14. **carbon-ai** — a hosted LLM/inference proxy, deployed as a
    carbon-functions-style HTTP endpoint, metered through carbon-billing's
    existing `usage_records` table (same shape Stripe usage billing
    already uses).

**Depends on:** Phase 3 (functions/compute to run the proxy on), Phase 0
(billing to meter it).
**Unblocks:** carbon-ai; pairs with carbon-vector (phase 2) for semantic
search use cases.

### Phase 5 — communications

15. **carbon-email** — transactional email via a real provider (SES/
    Postgres-backed send log), triggered from carbon-queue for retries.
16. **carbon-sms** — same shape as carbon-email, SMS gateway instead.
17. **carbon-webhooks** — outbound delivery with retry/backoff (needs
    carbon-queue) plus a verified inbound receiver.
18. **carbon-push** — hosted push fanout across every device an end user
    (carbon-auth, phase 1) is signed into.

**Depends on:** Phase 3 (carbon-queue for retry/backoff), Phase 1
(carbon-auth for "every device this end user is signed into").
**Unblocks:** carbon-email, carbon-sms, carbon-webhooks, carbon-push.

### Phase 6 — observability

19. **carbon-logs** — centralized log aggregation across every install of
    an app (distinct from the already-shipped LOCAL `logging` plugin,
    which writes to the device's own disk).
20. **carbon-monitoring** — the crash/error aggregation dashboard a local
    Could-have "Crash Reporting" hook (not yet built either) would upload
    into.
21. **carbon-analytics** — Carbon-hosted, opt-in product analytics.

**Depends on:** Phase 1 (identity/org scoping for "which app's logs are
these"), and is more useful once phases 2-5 exist (something to observe).
**Unblocks:** carbon-logs, carbon-monitoring, carbon-analytics.

### Phase 7 — product/growth

22. **carbon-flags** — hosted feature flags / remote config, read at
    startup and live-updated over the same channel carbon-realtime (phase
    2) already provides.
23. **carbon-status** — a hosted status page and incident feed for an
    app's own service health, fed by carbon-monitoring (phase 6).

**Depends on:** Phase 2 (carbon-realtime's push channel), Phase 6
(carbon-monitoring, for carbon-status's incident feed).

### Phase 8 — commerce

24. **carbon-payments** — hosted checkout/payment rails for one-off
    purchases, Carbon as merchant of record — the same Stripe integration
    carbon-billing (phase 0) already has, generalized from recurring
    subscriptions to one-off charges.

**Depends on:** Phase 0 (carbon-billing's existing Stripe plumbing).

### Phase 9 — collaboration & support

25. **carbon-teams** — reuses carbon-identity's (phase 0) org/membership
    model, extended to an app's own end users instead of only Carbon
    developer accounts.
26. **carbon-support** — an embeddable support widget + ticket inbox.

**Depends on:** Phase 1 (carbon-auth, for which end user is asking) and
Phase 0 (carbon-identity's org model, for carbon-teams specifically).

### Phase 10 — delivery

27. **carbon-cdn** — edge-cached delivery for static files and
    carbon-storage (phase 1) objects.
28. **carbon-domains** — custom domain/DNS management for anything an app
    exposes (auth callback URLs, webhook endpoints from phase 5, a
    marketing site).

**Depends on:** Phase 1 (carbon-storage, for what carbon-cdn caches) and
Phase 5 (carbon-webhooks' inbound receiver needs a real domain to receive
on).

### Phase 11 — plugin ecosystem

29. **carbon-registry** — a real hosted plugin registry: fetch, signing
    verification, and a sandboxed install broker, replacing today's
    local-workspace-only resolution (`carbon plugin add <name>` against
    `products/carbon-sdk/`). Needs carbon-storage (artifact hosting),
    carbon-cdn (distribution), and carbon-identity (publisher accounts).
30. **carbon-trust**, wired in — `carbon-plugin-sign`/`carbon-import-check`/
    `dev-key` (`solutions/capabilities/plugin/trust/rust/tools`) already
    exist as real, working CLI binaries; this phase is wiring them into
    carbon-registry's publish pipeline, not building new crypto.

**Depends on:** Phase 1 (carbon-storage), Phase 10 (carbon-cdn), Phase 0
(carbon-identity).

## Full plugin → dependency map

The phase numbers below are still the right BUILD order (identity before
data before compute before AI, etc.) — the Service map above says which
PRODUCT each phase's work now happens inside, replacing this doc's earlier
single-process framing.

| Plugin | Depends on | Status |
|---|---|---|
| carbon-manifest | nothing (local) | ✅ shipped |
| carbon-runtime | nothing (local) | ✅ shipped |
| carbon-framecache | nothing (local) | ✅ shipped |
| carbon-snapshot | nothing (local) | ✅ shipped |
| carbon-secrets | nothing (local) | ✅ shipped |
| carbon-identity | Phase 0 | real, self-hosted only |
| carbon-auth | Phase 0 (tokens) + Phase 1 (end-user auth) | partially real |
| carbon-billing | Phase 0 | real, self-hosted only |
| carbon-orchestration | Phase 0 | real, self-hosted only (build pipeline) |
| carbon-worker | Phase 0 (builds) + Phase 3 (general jobs) | partially real |
| carbon-database | Phase 1 | exists as prototype (`products/carbon-database`), needs real persistence |
| carbon-storage | Phase 1 | not built |
| carbon-migrations | Phase 1 + Phase 2 | not built |
| carbon-realtime | Phase 1 + Phase 2 | not built |
| carbon-search | Phase 1 + Phase 2 | not built |
| carbon-vector | Phase 1 + Phase 2 | not built |
| carbon-backup | Phase 1 + Phase 2 | not built |
| carbon-functions | Phase 1 + Phase 3 | not built |
| carbon-queue | Phase 1 + Phase 3 | not built |
| carbon-cron | Phase 3 | not built |
| carbon-edge | Phase 3 | not built |
| carbon-ai | Phase 0 + Phase 3 + Phase 4 | not built |
| carbon-email | Phase 1 + Phase 3 + Phase 5 | not built |
| carbon-sms | Phase 1 + Phase 3 + Phase 5 | not built |
| carbon-webhooks | Phase 3 + Phase 5 | not built |
| carbon-push | Phase 1 + Phase 5 | not built |
| carbon-logs | Phase 1 + Phase 6 | not built |
| carbon-monitoring | Phase 1 + Phase 6 | not built |
| carbon-analytics | Phase 1 + Phase 6 | not built |
| carbon-flags | Phase 2 + Phase 7 | not built |
| carbon-status | Phase 6 + Phase 7 | not built |
| carbon-payments | Phase 0 + Phase 8 | not built |
| carbon-teams | Phase 0 + Phase 1 + Phase 9 | not built |
| carbon-support | Phase 1 + Phase 9 | not built |
| carbon-cdn | Phase 1 + Phase 10 | not built |
| carbon-domains | Phase 5 + Phase 10 | not built |
| carbon-registry | Phase 0 + Phase 1 + Phase 10 + Phase 11 | exists as prototype (`products/carbon-registry`), needs real persistence |
| carbon-trust | Phase 11 (publish-pipeline wiring only — the signing/verify logic itself already exists) | mostly real |
| carbon-effects | nothing — internal Rust/Zig authoring pattern, not a hosted service or a JS-facing plugin | not applicable |
| carbon-test | nothing — launch-time env var (`CARBON_TEST_EVAL_AFTER_MS`), external test harnesses only, no JS-facing surface | not applicable |
| carbon-daemon | nothing — `carbon dev`/`run` process-pool optimization, no app-facing surface | not applicable |

## What this doc is not

It's not an estimate, a staffing plan, or a commitment — it's the dependency
order so whoever picks this up next doesn't build carbon-realtime before
carbon-database exists under it. Each phase is itself the size of the
Should-have OS-capability tier or larger; this is roadmap, not a sprint.
