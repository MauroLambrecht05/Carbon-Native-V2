# carbon-registry

The official Plugin & Component Registry / Marketplace for Carbon Native.
Self-hosted, v1.

```
composition/     the composition root (entrypoint.ts) — opens Postgres, runs
                  migrations, builds the S3 client, wires the registry engine
infrastructure/
  http/           routes.ts (the API), server.ts (Bun.serve + static marketplace UI)
  services/       RegistryEngine (real Postgres + S3), SecurityVerifier (pure
                  manifest/semver/checksum validation)
  persistence/    Database.ts (Postgres connection + migrations)
presentation/     the web marketplace (dark-mode directory) + CarbonRegistryClient,
                  the typed SDK the CLI's `carbon plugin` commands and this
                  product's own tests both use
```

## What it is

`carbon-registry` is the package marketplace for native Carbon plugins
(written in Zig or C ABI) and reusable desktop UI components. Developers
discover, download, and publish plugins with semantic versioning and
checksum verification.

- **Package Marketplace Web UI**: dark-mode directory, browse by category
  (`carbon-desktop`, `carbon-security`, `carbon-dev`, `carbon-media`,
  `carbon-ai`), search by keyword/capability, copy `carbon plugin add <name>`.
- **Integrity & Security**: SHA-256 checksum verification and manifest
  validation on every uploaded bundle (`SecurityVerifier`).
- **REST API**: post/retrieve plugins, download `.tar.zst` bundles, query
  categories, track download counts.
- **Standard Library pre-seeded**: `clipboard`, `dialog`, `notification`,
  `tray`, `keychain`, `sqlite`, `audio-player`.

## Identity is NOT owned here

This product keeps no `organizations`/`api_tokens` of its own. An org
signs up exactly once, on **carbon-cloud** (`POST /v1/orgs`); every
`POST /api/v1/publish` request here is verified by calling carbon-cloud's
real `GET /v1/auth/verify` over HTTP (`HttpIdentityClient`, in
`@carbon/identity`) — real SSO across products, matching carbon-database's
own posture, not a duplicate copy of the same account data. The CLI
(`carbon plugin publish`) already expects this: it reads
`CARBON_REGISTRY_TOKEN=cc_...`, the same token `carbon cloud signup`
issues, not a registry-specific one.

This means **running this product standalone requires a reachable
carbon-cloud instance** — set `CONTROL_PLANE_URL`. The default in
`docker-compose.yml` (`http://host.docker.internal:8080`) reaches a
`docker compose up` in `../carbon-cloud` running on the same host.

## Run it locally

```sh
cd ../carbon-cloud && docker compose up -d postgres minio minio-init control-plane   # identity this product delegates to
cd ../carbon-registry && docker compose up   # Postgres + MinIO + this API
```

```sh
# Sign up (real, on carbon-cloud)
curl -X POST http://localhost:8080/v1/orgs -H 'content-type: application/json' -d '{"name":"My Guild"}'
# -> {"orgId":"...","apiToken":"cc_..."}

# Publish a plugin to the registry with that token
curl -X POST http://localhost:54323/api/v1/publish -H "Authorization: Bearer cc_..." -H 'content-type: application/json' \
  -d '{"manifest":{"name":"my-plugin","version":"1.0.0","category":"carbon-dev","description":"..."},"tarballBase64":"..."}'
```

## API Endpoints

- `GET /api/v1/health` — service health check
- `GET /api/v1/stats` — package and download metrics
- `GET /api/v1/categories` — distinct plugin categories
- `GET /api/v1/plugins` — list & search plugins (`?category=&search=&platform=&limit=&offset=`)
- `GET /api/v1/plugins/:name` — plugin details, README, and version history
- `GET /api/v1/plugins/:name/:version/download` — download a specific version's tarball (`:version` optional, defaults to latest)
- `POST /api/v1/publish` — publish a new plugin version (requires `Authorization: Bearer cc_...`)

## What's real, verified against real infrastructure

`RegistryEngine` used to be a static in-memory `Map` — a convincing
prototype with a full REST API, but nothing survived a restart, and it
kept its own `InMemoryIdentityRepository`/`CreateOrganizationUseCase`
instead of delegating to carbon-cloud. Both are fixed now:

- **Metadata** (`plugins`/`plugin_versions`) is real Postgres —
  verified by publishing a plugin, **restarting the container**, and
  confirming the plugin, its checksum, and its download counter were
  all still there.
- **Tarball bytes** are real S3-compatible storage via Bun's own
  `S3Client` (MinIO in dev, key `${name}/${version}.tar.zst`) — verified
  with a real publish, then a real download decoding back to the exact
  original bytes.
- **Identity** is a real `HttpIdentityClient` call to a live carbon-cloud
  instance — verified end to end: signed up a real org on carbon-cloud,
  used the real `cc_...` token to publish here, confirmed an invalid
  token is rejected (400) and a plugin owned by a different org can't be
  overwritten (`Unauthorized: ... owned by a different organization`).

**One real bug found by actually running this, not by review**: the
first publish of a brand-new plugin failed with a genuine Postgres
foreign-key violation (`plugin_versions_plugin_name_fkey`) — the version
row was being inserted before the plugin row it references existed.
Fixed by creating/updating the `plugins` row first, the `plugin_versions`
row second (see `RegistryEngine.publish`'s own comment).

## What's not built

No per-plugin download-count analytics beyond a running total, no
plugin deletion/deprecation endpoint, no rate limiting on publish. The
web marketplace (`presentation/`) still calls the same REST API
unchanged — untouched in this pass.

## Running Tests

```sh
bun test products/carbon-registry
```

Only pure logic and the HTTP surface (over fakes) are unit-tested here —
same posture as carbon-database's own test suite, which doesn't
unit-test its Postgres-backed engines either:

- `security-verifier.test.ts` — manifest/semver/checksum validation, pure.
- `routes.test.ts` — request parsing, auth gating, status codes, over a
  fake `verifyToken`/`RegistryEnginePort` (no database, no carbon-cloud).
- `e2e.test.ts` — the full client (`CarbonRegistryClient`) ↔ server
  request/response contract, over a real `Bun.serve` with the same fakes.

`RegistryEngine` itself is verified by actually running the stack (see
"What's real" above), not `bun test`.
