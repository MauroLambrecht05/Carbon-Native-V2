# carbon-cloud

The real account email/session API is available behind the explicit
`CARBON_ACCOUNT_AUTH` flag, with PostgreSQL state, encrypted delivery jobs and a
separate Resend mail worker. See [account authentication setup](docs/account-authentication.md)
and the [backend implementation evidence](docs/platform-backend-progress.md).
The real [catalog and provisioning API](docs/catalog-provisioning.md) now includes
durable project/environment creation and a separate signed provisioning worker.
Database/Registry lifecycle receivers now provision native resources over signed
HTTP with live Cloud authority checks; see the [service setup and limits](docs/service-lifecycle.md).
The [account-facing Data API](docs/account-data.md) forwards table/policy and row
operations to Database with native row policies and encrypted pagination.
The [durable import API and worker](docs/data-imports.md) stage encrypted CSV/JSON
and reconcile committed receipts before retrying or confirming cancellation.
The dashboard below still uses mock services; production browser integration and
the remaining backend workflows are in progress.

## Platform frontend: Slices 1-10

The React frontend runs independently in **mock mode**. Slice 1 implements
contracts, scope-aware routing, permissions, persistent fixtures, clock,
operations/events and mock controls. Slice 2 adds account sign-up/sign-in,
the development challenge inbox, MFA/recovery, account and session management,
organizations, invitations, scoped membership grants and project/environment
provisioning. Slice 3 adds repository installations and project configuration,
computed setup checklists, environment API settings, service and personal
credentials, secret metadata, service accounts, CLI device authorization, and
filtered activity. Credential values are fake, shown once, and never persisted
as plaintext. Slice 4 adds Windows build preflight, immutable inputs, attempts,
leases, stages/logs, workers, artifacts, signing metadata, release publication,
channels, rollout, promotion, rollback and withdrawal. Everything remains
simulated locally; downloads are inert fixture text and client capability
limits are explicit.

Slice 5 adds relational tables/rows, schema dependencies and constraints,
owner/public-read policies, CSV/JSON import/export, bounded SQL fixtures,
realm users/providers/sessions, hosted mock app sign-in and frontend/backend
integration recipes. App sessions remain separate from Carbon account sessions.
Existing environments without Auth bindings require explicit provisioning from
environment overview. Slice 6 adds binary buckets/objects/versioning, scoped
expiring transfer links, deterministic vector search and graph traversal,
policy-authorized realtime inspection, migration planning/promotion/rollback,
and snapshots, retention schedules and tracked partial restore operations.
All bytes and operations stay in the local mock workspace.

Slice 7 adds function source autosave, immutable deployments, named execution
fixtures, invocation details and retries, timezone-aware schedules, secret version
bindings, promotion and rollback. Enable Functions from environment overview.
Source is never executed and no function endpoint is contacted.

Slice 8 adds public Registry discovery, publisher package/version workflows,
synthetic Windows archive review, immutable publication metadata, project plugin
resolution, capability grants, mock source synchronization and build provenance.
The fixtures never claim to be working DLLs and no repository or Registry service
is contacted.

Slice 9 adds fictional subscription and provider-event workflows, classified
usage, budgets and hard-cap consequences, local invoice fixtures, environment
limits, retention previews, and a separately authorized operator surface for
jobs, managed Windows workers, Registry review, trust rotation, organization
suspension and immutable billing adjustments. Slice 10 completes the
consistency pass: Slice 9 mutations use the same persisted revisions,
idempotency, audit, scope invalidation and authorization rules as earlier
slices; quota and suspension decisions affect charged work; direct routes have
local outcomes; session and membership changes still clear scoped data; and
the browser composition remains mock-only with `connect-src 'none'`.

From the repository root:

```sh
bun run --cwd products/carbon-cloud dev:mock
bun run --cwd products/carbon-cloud typecheck:browser
bun run --cwd products/carbon-cloud test:browser
bun run --cwd products/carbon-cloud build:mock
```

Use `bun.cmd` if PowerShell blocks the `bun.ps1` shim. Open
`http://127.0.0.1:5175` and register a fake account, following its verification
link in Mock tools, or choose a fixture identity. No Carbon API,
Postgres, MinIO, worker, or provider environment variables are needed.

See [Slice 1 contracts, walkthrough and pending decisions](docs/platform-frontend-slice-1.md)
and [Slice 2 identity and platform shell](docs/platform-frontend-slice-2.md),
[Slice 3 project configuration and credentials](docs/platform-frontend-slice-3.md),
[Slice 4 Windows builds and releases](docs/platform-frontend-slice-4.md),
[Slice 5 relational data and app authentication](docs/platform-frontend-slice-5.md),
[Slice 6 data extensions](docs/platform-frontend-slice-6.md),
[Slice 7 functions](docs/platform-frontend-slice-7.md),
[Slice 8 Registry and plugin use](docs/platform-frontend-slice-8.md),
[Slice 9 billing and platform operators](docs/platform-frontend-slice-9.md),
[Slice 10 consistency pass](docs/platform-frontend-slice-10.md),
and the [complete platform plan](docs/platform-frontend-plan.md).
The production implementation and mock-to-real cutover are specified in the
[full platform backend plan](docs/platform-backend-plan.md).

The former organization-token dashboard has been retired. The backend root page
now points to the separate mock command; `/dashboard.js` returns 410. Backend
capabilities and historical verification below describe the existing service,
not functionality connected to this mock frontend.

## Existing backend

Carbon Cloud: push a repo, get a signed installer and a working auto-update
— the same job Vercel does for a Next.js deploy. Self-hosted, v1.

```
composition/     the control plane's entrypoint (main.ts), each worker's
                  (worker-{linux,windows,macos}.ts, sharing worker.ts), and
                  the Dockerfiles — macOS has none, see worker-macos.ts
infrastructure/
  http/           the API: create/claim/complete a build
  persistence/    Postgres connection + migrations
presentation/     the mock platform frontend (React), independently composed.
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

Billing runs against `FakeCheckoutSessionProvider` unless `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID_PRO` are all set on the
control plane — with those, `POST /v1/billing/checkout` creates a real
Stripe Checkout Session and the plan upgrades for real once
`POST /v1/billing/webhook` (register this URL in the Stripe dashboard)
receives a signed `checkout.session.completed` event.

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
cast on plain interpolation.

**The Linux worker's compile step was proven for real too**, not just
built: `cargo build --release` for `carbon-mini` was run inside the worker
image against a real app (`labs/examples/my-app`), all the way through to
`packageTarget()` producing a real `.deb`. Getting there surfaced four more
real bugs, none of them found by review or unit tests: `softbuffer` and
`notify-rust` both had `default-features = false` in `products/carbon/
Cargo.toml`/`solutions/infrastructure/os/Cargo.toml` with no platform
backend re-added, so a full build hit 25 compile errors in softbuffer's
dispatch macro (empty enum — no `x11`/`wayland` variant compiled in) and a
zbus 5.13.2 vs. notify-rust 4.17.0 version-incompatibility break; the fix
was `features = ["x11", "wayland"]` on softbuffer and switching notify-rust
from its `zbus` backend to `dbus` (older, no equivalent break). Enabling
`x11` then needed `libx11-xcb-dev` on the image (the existing
`libxrandr-dev`/`libxi-dev` don't provide `x11-xcb.pc`), and `dbus` needed
`libdbus-1-dev`. Separately — a real bug independent of any dependency
version — `solutions/capabilities/rendering/snapshot/lib.rs`'s Windows-only
`Restored` struct was missing its `#[cfg(windows)]` gate, colliding with
the `#[cfg(not(windows))]` stub of the same name on every non-Windows
build. The resulting `.deb` was inspected directly (`dpkg-deb -c`/`-I`): a
real 6.4MB package containing a real 24MB compiled `carbon-mini` binary at
`/usr/lib/carbon/my-app` with correct control metadata.

**The full loop has now been run for real, end to end**, not staged in
pieces: `docker compose down -v` to a genuinely clean state, `docker
compose up`, sign up for a real org, mint a real worker token, queue a real
build against a real git repo — and watch a real worker claim it, `git
clone`+`git checkout` for real, `cargo build --release` for real, package a
real `.deb`, and upload it. That last step failed the first time through
with `NoSuchBucket`: nothing in this stack ever created the MinIO bucket
(`Bun.S3Client` only does object operations, not bucket management). Fixed
with a `minio-init` compose service (the standard `mc`-based provisioning
pattern). Fixing that surfaced a second real gap one layer down: the
bucket MinIO created was private, so the artifact's public URL — the same
kind of URL the dashboard links to and an update client's `manifest_url`
would point at — 403'd on a plain unauthenticated `curl`. Fixed with `mc
anonymous set download`. Re-ran the entire loop from another clean
`docker compose down -v` with zero manual steps: build succeeded, artifact
uploaded, downloaded over plain HTTP, sha256 matched the build record
exactly.

Real: the build queue (Postgres, `FOR UPDATE SKIP LOCKED` claims), all three
workers' packaging code (`dpkg-deb`/`appimagetool`/`makensis`/`wix`/`appdmg`,
Authenticode on Windows, codesign+notarization on macOS, upload to
S3-compatible storage), two separate token scopes gating every `/v1/*`
request — `org` (carbon-cli: create a build, read usage) and `worker`
(minted separately via `carbon cloud worker-token`, scoped to claim/complete
only the queue of the org that minted it — verified for real against
Postgres with two real orgs: a second org's worker token gets `204` against
the first org's queued build, not the build) — usage metering (a build over
the free plan's 60 included minutes/month gets a 402).

The Windows and macOS workers' Dockerfile/no-Dockerfile split is still
unverified the way the Linux one now partly is — no Windows Docker host, no
Mac in this dev sandbox.

The former dashboard used an organization token in localStorage for real API
calls. It has been replaced by the independently runnable mock frontend above.
`carbon cloud list` remains the CLI for the existing backend.

`dmg`'s builder now assembles a real `.app` bundle
(`Contents/{MacOS,Resources}` + a generated `Info.plist`) around the binary
before packaging it, rather than putting the loose binary straight in the
dmg — verified as far as this sandbox can: unit-tested tree/plist contents,
but `appdmg` itself is a macOS-only tool (shells out to `hdiutil`), so
nothing here has run the actual dmg build or launched the resulting `.app`
on real macOS.

**Billing is a real Stripe Checkout integration**, not `FakePaymentProvider`
anymore. The old `PaymentProvider.chargeForPlan(orgId, plan)` port assumed
a synchronous backend charge, which was never going to fit any real
processor (PCI-restricted card collection needs client-side tokenization).
Replaced with the shape Checkout actually has — `StartPlanUpgradeUseCase`
creates a Stripe-hosted Checkout Session and returns its URL; the plan only
changes in `ConfirmPlanUpgradeUseCase`, called from the new
`POST /v1/billing/webhook` route once Stripe's `checkout.session.completed`
event confirms real payment, never from the browser's redirect back to
`successUrl` (reachable without having paid). `StripeCheckoutProvider`
calls Stripe's REST API directly via `fetch` — no SDK dependency — and
`verifyStripeWebhookSignature` reimplements Stripe's documented HMAC
signature check by hand (replay-window + constant-time compare); without
that, anyone who finds the webhook URL could POST themselves a free
upgrade. `FakeCheckoutSessionProvider` is still the default when
`STRIPE_SECRET_KEY` isn't set. The retired dashboard exposed an "Upgrade to Pro"
button. Verified historically: the full billing/routes test suites, the checkout+webhook
routes against a real control plane and Postgres, and the whole flow
clicked through in a real browser — which caught a real bug live,
`FakeCheckoutSessionProvider` producing a malformed double-`?` URL, since
fixed. What's *not* verified: actual Stripe API calls — no Stripe account
or test API key in this environment, so `StripeCheckoutProvider` and the
signature verifier are real, correct code against Stripe's documented
contracts, checked as far as a sandbox with no Stripe access can check them.

## End-user (magic-link) auth — `@carbon/auth`

Distinct from everything above: `organizations`/`api_tokens` are the app
**developer's** account (what `carbon-cli` authenticates as); `end_users`/
`end_user_sessions` are an app's **own customers** — someone the app's
frontend needs to sign in, who never touches `carbon-cli` at all. Three
routes, no bearer token required on the first two (an anonymous visitor
requesting a sign-in link has none yet):

```sh
# 1. Request a link for an email, scoped to your own org.
curl -X POST http://localhost:8080/v1/end-users/magic-link \
  -d '{"orgId":"<your-org-id>","email":"customer@example.com"}'
# -> {"endUserId":"...","expiresAt":"...","devMagicLink":"ml_..."}

# 2. Exchange it for a session (normally the link a real email pointed at).
curl -X POST http://localhost:8080/v1/end-users/session -d '{"magicLinkToken":"ml_..."}'
# -> {"endUserId":"...","orgId":"...","sessionToken":"es_...","expiresAt":"..."}

# 3. Verify a session — what an authenticated end-user request checks.
curl http://localhost:8080/v1/end-users/me -H "authorization: Bearer es_..."
# -> {"endUserId":"...","orgId":"..."}
```

**`devMagicLink` is not how this works with real email** — there is no
email transport yet (`carbon-email` is unbuilt; see the roadmap's own
phase 5), so the route hands the usable token straight back in its own
response instead of pretending a delivery step happened. That is a
deliberate, visible self-hosted-dev shortcut, not the real security
model — the field name says so on purpose, the same way
`FakeCheckoutSessionProvider` is named `Fake` rather than silently
standing in for Stripe. A real deployment sends this over email and never
returns it here.

**What's real**: the full magic-link → session → verify round trip, real
Postgres tables (`0004_auth.sql`), single-use token consumption (a second
exchange attempt with the same plaintext is refused even before it would
have expired), 15-minute link / 30-day session TTLs, and — the one actual
security bug this caught in its own design, not from review — the session
an exchange produces is scoped to the token's **own** end user's org,
looked up server-side, never accepted as a caller-supplied parameter (see
`ConsumeMagicLinkUseCase`'s own comment for why that distinction matters:
accepting it would let anyone holding a valid magic link for their own
account claim a session in a *different* org just by naming one).

**What's not built**: OAuth (Google/GitHub/etc. sign-in) — real, separate
scope per provider, not a variant of this same code, and the roadmap
groups it with this capability only because both answer "how does an end
user prove who they are." No session revocation/logout endpoint yet
(`DELETE /v1/end-users/session` — a real gap, not a decision). No rate
limiting on `/v1/end-users/magic-link`, so nothing here stops repeated
requests for the same email from piling up (harmless today since nothing
actually emails anyone yet, but a real gap once `carbon-email` exists).
