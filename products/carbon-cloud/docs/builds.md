# Builds

A build turns one exact commit into declared artifacts for an environment. It
runs on an enrolled worker through a lease ([workers.md](workers.md)), which is
also how the worker gets the secrets the build names. The wire contract is in
[build-api.openapi.json](build-api.openapi.json); storage is Cloud migration
`0026_platform_builds.sql`. Builds exist when `CARBON_WORKERS=enabled`.

These are the canonical, environment-scoped builds. The legacy organization-wide
queue (`/v1/builds`, `wk_` tokens) is separate and unchanged.

## Creating a build

`POST .../environments/{id}/builds` with a commit SHA, targets, the names of the
secrets the build needs, and the worker platform. It needs `release.publish`,
CSRF and an idempotency key.

In one transaction Cloud:

1. canonicalizes the input and stores it with its SHA-256 digest;
2. reserves 30 minutes against the organization's monthly build minutes;
3. grants the worker lease for the build.

Either all three commit or none does. A retried request with the same key
returns the same build.

**The input is immutable.** Every attempt, on any worker, receives the same
stored input and digest. A database trigger refuses any change to it, and to the
state of a finished build, even from a direct SQL statement.

**Quota.** The limit is the plan's included minutes (`free` 60, `pro` 6000).
Available minutes are the limit, minus minutes used this month, minus 30 for
every build still queued or running. Reservations for one organization are
serialized, so two requests cannot both take the last slot. A build with no room
is refused with 429. The reservation ends when the build finishes; minutes
actually used are recorded then.

## Running a build

The worker authenticates with its `wc_` credential and the lease's `wl_` token.

| Route | Purpose |
|---|---|
| `POST /worker/v1/leases/{id}/build` | The build input; starts the attempt |
| `POST /worker/v1/leases/{id}/build/logs` | Append one log segment |
| `POST /worker/v1/leases/{id}/build/artifacts` | Declare one output |
| `POST /worker/v1/leases/{id}/build/complete` | Report `succeeded` or `failed` |

Heartbeats and secret delivery are the lease's own routes.

**Logs** are append-only and gapless per build, across attempts. A segment must
carry the next sequence number. Resending a stored segment with the same content
is accepted; different content is refused. Segments are at most 64 KiB, and a
build holds at most 5,000 segments and 16 MiB. Anything shaped like a credential
this platform issues is stored as `[redacted]`. Developers read logs with
`GET .../builds/{id}/logs?after=N`.

**Artifacts** are declared per target with an object key, size and SHA-256. A
declaration cannot be changed. A build can succeed only when every target has
one. A build's outputs are those of the attempt that succeeded.

**Completion** ends the lease, the attempt and the build together and settles
quota from the time attempts actually ran, rounded up to whole minutes.

## When things go wrong

| Situation | Result |
|---|---|
| The worker stops heartbeating | The lease expires; the lease sweeper offers the same input again as the next attempt, on a new lease. The lost worker can do nothing more. Up to three attempts. |
| Lost on the last attempt | The build fails as `worker_lost` |
| Nobody claims it within 30 minutes | The build fails as `no_worker` |
| The worker reports failure | The build fails with the worker's error category and is not retried |
| The build passes its 30-minute deadline | The build fails as `deadline_exceeded` and its lease is cancelled |
| A developer cancels it | The lease is cancelled first, then the build is `cancelled`. The worker's next heartbeat says so, and it can neither read secrets nor report success. |

Cancelling needs to be the build's creator or to hold `build.cancel.any`.

`worker-lease-sweeper` runs both steps: it expires overdue leases and creates
successors, then fails builds that have no lease left. Finished states never
change.

## Events

Build events (`build.queued`, `build.attempt_started`, `build.succeeded`,
`build.failed`, `build.cancelled`) appear in the organization log
([audit-events.md](audit-events.md)).

## Not included

See [gaps.md](left-off/gaps.md), entries G-27 to G-35. In short: Cloud does not
verify that declared artifacts exist or match their digest; the input is a
commit and targets, not a full snapshot of configuration, toolchain and
dependency locks; a commit is not resolved from a branch here; there is no
dedicated build permission; secret values are not removed from logs by Cloud;
logs are polled, not streamed; and the legacy `wk_` queue is still separate.
