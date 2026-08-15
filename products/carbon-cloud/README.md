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
The Linux worker needs `WORKER_API_TOKEN` set to a *real* token (see below —
`docker-compose.yml`'s `dev-token` default is a placeholder and will get a
401 until you replace it) — sign up once, then export it before `up`.

## Trigger a build

```sh
# Once: create the org the worker and the CLI both authenticate as.
bun products/carbon-cli/main.ts cloud signup --url http://localhost:8080 --name "My Org"
# Copy the printed token into WORKER_API_TOKEN and restart worker-linux.

bun products/carbon-cli/main.ts cloud deploy --repo <git-url> --commit <sha> --target deb
bun products/carbon-cli/main.ts cloud status <build-id>
```

Already have a token (a second machine, CI)? `cloud login --url <url> --token
<token>` saves it without creating another org.

## What's real vs. what's next

Real: the build queue (Postgres, `FOR UPDATE SKIP LOCKED` claims), all three
workers (checks out, builds, packages for real via
`dpkg-deb`/`appimagetool`/`makensis`/`wix`/`appdmg`, signs with Authenticode
on Windows and codesign+notarization on macOS, uploads to S3-compatible
storage), orgs + API tokens gating every `/v1/builds/*` request, usage
metering (a build over the free plan's 60 included minutes/month gets a 402,
not silently allowed through).

The Linux and Windows workers are Dockerized; the macOS worker is not — see
`composition/worker-macos.ts`'s own note. Docker cannot run macOS at all, so
that worker runs directly on real Mac hardware. None of the three workers
have been run against real infrastructure in this repo's own dev sandbox
(no reachable Docker daemon, no Mac); each is built and unit-tested against
fakes for every subprocess call, to the same standard the rest of this
product is.

Not real yet: `@carbon/billing`'s `PaymentProvider` — `UpgradePlanUseCase`
changes the stored plan on a successful charge, but the only implementation
is `FakePaymentProvider`, which always succeeds without moving any money.

The dashboard (`presentation/`, React) covers signup, pasting an
existing token, usage against the plan, queuing a build, and checking one's
status — a token typed in lives in the browser's localStorage for the tab's
session; there's no cookie session yet.

Not yet: per-build authorization (any valid token can claim/complete any
org's queued work — fine for one self-hosted deployment you control every
worker for, a real gap for multiple untrusted tenants), a build
list/history view (only look-up-by-id exists), a proper `.app` bundle for
macOS (`dmg`'s builder packages the raw runtime binary today — see the
KNOWN GAP note in `packaging/infrastructure/builders/dmg.ts`).
