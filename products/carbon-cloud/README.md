# carbon-cloud

Carbon Cloud: push a repo, get a signed installer and a working auto-update
— the same job Vercel does for a Next.js deploy. Self-hosted, v1.

```
composition/     the control plane's entrypoint (main.ts), each worker's
                  (worker-{linux,windows,macos}.ts, sharing worker.ts), and
                  the Dockerfiles — macOS has none, see worker-macos.ts
infrastructure/
  http/           the API: create/claim/complete a build, serve the dashboard
  persistence/    Postgres connection + migrations
presentation/     the v1 dashboard (React) — signup, usage, deploy, status.
                  No subfolder: it's the only presentation surface this
                  product has, so it sits at presentation/ directly rather
                  than presentation/dashboard/.
```

## Run it locally

```sh
cd products/carbon-cloud
docker compose up
```

Brings up Postgres, MinIO, the control plane (`:8080`) and one Linux worker.
The Linux worker needs `WORKER_API_TOKEN` set to a *real worker token*
specifically — `docker-compose.yml`'s `dev-token` default is a placeholder
and will get a 401 (then a 403 even with a real org token: claiming needs
worker scope, not org scope — see "auth" below) until you replace it.

## Trigger a build

```sh
# Once: create the org carbon-cli authenticates as.
bun products/carbon-cli/main.ts cloud signup --url http://localhost:8080 --name "My Org"
# Once: mint a worker token FROM that org token — a different credential,
# not the one signup just printed. Copy it into WORKER_API_TOKEN and
# restart worker-linux (and any Windows/macOS workers, same token).
bun products/carbon-cli/main.ts cloud worker-token

bun products/carbon-cli/main.ts cloud deploy --repo <git-url> --commit <sha> --target deb
bun products/carbon-cli/main.ts cloud status <build-id>
```

Already have a token (a second machine, CI)? `cloud login --url <url> --token
<token>` saves it without creating another org.

## What's real vs. what's next

**Verified against real infrastructure**, not just unit tests: with a real
Docker Desktop, the control plane was built and run against a real Postgres
and MinIO, and the full `POST /v1/orgs` -> `POST /v1/builds` -> claim ->
complete -> `GET /v1/usage` loop was exercised end to end with `curl` and
double-checked with `psql` directly against the database. That run caught
and fixed four real bugs review hadn't: `bun.sh/install` needs `unzip`
(missing from `debian:bookworm-slim`), neither Dockerfile ran `bun install`
at all, `PostgresBuildRepository.save()` double-JSON-encoded `targets`/
`artifacts` (Bun.SQL already encodes a bound value for a `::jsonb` cast —
pre-`JSON.stringify`ing it was the bug), and the target-platform filter in
`claimNext` needed `sql.array(x, "text")` specifically, not a `::text[]`
cast on plain interpolation. The Linux worker image was also built for real
(a wrong `appimagetool` release tag, fixed) but a build has not yet been run
through it end to end — that's the next real-infrastructure test worth doing.

Real: the build queue (Postgres, `FOR UPDATE SKIP LOCKED` claims), all three
workers' packaging code (`dpkg-deb`/`appimagetool`/`makensis`/`wix`/`appdmg`,
Authenticode on Windows, codesign+notarization on macOS, upload to
S3-compatible storage), two separate token scopes gating every `/v1/*`
request — `org` (carbon-cli: create a build, read usage) and `worker`
(claim/complete any org's queue, minted separately via
`carbon cloud worker-token`) — usage metering (a build over the free plan's
60 included minutes/month gets a 402).

The Windows and macOS workers' Dockerfile/no-Dockerfile split is still
unverified the way the Linux one now partly is — no Windows Docker host, no
Mac in this dev sandbox.

Not real yet: `@carbon/billing`'s `PaymentProvider` — `UpgradePlanUseCase`
changes the stored plan on a successful charge, but the only implementation
is `FakePaymentProvider`, which always succeeds without moving any money.

The dashboard (`presentation/`, React) covers signup, pasting an
existing token, usage against the plan, queuing a build, and checking one's
status — a token typed in lives in the browser's localStorage for the tab's
session; there's no cookie session yet.

Not yet: a worker token isn't scoped to the specific org that minted it —
any worker token can claim/complete any org's queued work, which is correct
for a shared worker fleet but means a compromised worker token from one org
can see what other orgs are building (fine for one self-hosted deployment
you run every worker for yourself; a real gap for multiple mutually
untrusting tenants). Also: a build list/history view (only look-up-by-id
exists), a proper `.app` bundle for macOS (`dmg`'s builder packages the raw
runtime binary today — see the KNOWN GAP note in
`packaging/infrastructure/builders/dmg.ts`).
