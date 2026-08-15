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

## Trigger a build

```sh
bun products/carbon-cli/main.ts cloud login --url http://localhost:8080 --token dev-token
bun products/carbon-cli/main.ts cloud deploy --repo <git-url> --commit <sha> --target deb
bun products/carbon-cli/main.ts cloud status <build-id>
```

## What's real vs. what's next

Real: the build queue (Postgres, `FOR UPDATE SKIP LOCKED` claims), the Linux
worker (checks out, builds, packages `.deb`/`.AppImage` for real via
`dpkg-deb`/`appimagetool`, uploads to S3-compatible storage), the dashboard.

Not yet: Windows/Mac workers, accounts/orgs (everything is org `"default"`
today), billing, a real dashboard beyond build-status lookup.
