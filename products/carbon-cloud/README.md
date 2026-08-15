# carbon-cloud

Carbon Cloud: push a repo, get a signed installer and a working auto-update
— the same job Vercel does for a Next.js deploy. Self-hosted, v1.

```
composition/     the control-plane entrypoint (main.ts), the Linux worker's
                  entrypoint (worker-linux.ts), and the two Dockerfiles
infrastructure/
  http/           the API: create/claim/complete a build, serve the dashboard
  persistence/    Postgres connection + migrations
presentation/
  dashboard/      the v1 status page (React) — paste a build id, see its status
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

Real: the build queue (Postgres, `FOR UPDATE SKIP LOCKED` claims), the Linux
and Windows workers (checks out, builds, packages for real via
`dpkg-deb`/`appimagetool`/`makensis`/`wix`, signs with Authenticode on
Windows, uploads to S3-compatible storage), orgs + API tokens gating every
`/v1/builds/*` request, usage metering (a build over the free plan's 60
included minutes/month gets a 402, not silently allowed through).

Not real yet: `@carbon/billing`'s `PaymentProvider` — `UpgradePlanUseCase`
changes the stored plan on a successful charge, but the only implementation
is `FakePaymentProvider`, which always succeeds without moving any money.

The dashboard (`presentation/dashboard`, React) covers signup, pasting an
existing token, usage against the plan, queuing a build, and checking one's
status — a token typed in lives in the browser's localStorage for the tab's
session; there's no cookie session yet.

Not yet: a Mac worker, per-build authorization (any valid token can
claim/complete any org's queued work — fine for one self-hosted deployment
you control every worker for, a real gap for multiple untrusted tenants), a
build list/history view (only look-up-by-id exists).
