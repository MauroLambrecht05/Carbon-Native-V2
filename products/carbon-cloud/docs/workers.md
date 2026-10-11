# Workers, leases and secret delivery

A worker is a machine an organization enrolls to run builds or functions. It
never sees a secret unless Cloud's own orchestration has granted it a lease that
names that secret. The wire contract is in
[worker-api.openapi.json](worker-api.openapi.json); storage is Cloud migration
`0022_workers.sql`. Enable with `CARBON_WORKERS=enabled`, which requires
`CARBON_SECRETS=enabled`.

## Three credentials, three jobs

| Credential | Issued to | Lifetime | Used for |
|---|---|---|---|
| `we_` enrollment code | An organization manager, once | 15 minutes, single use | Turning a pending worker into an active one |
| `wc_` worker credential | The worker, at enrollment or rotation | 30 days | Authenticating every worker call |
| `wl_` lease token | The worker, when it claims a lease | The lease | Acting on that one lease |

Each is shown once and stored as a SHA-256 hash. The worker API accepts none of
the other credential types (`dc_`, `cs_`, `pt_`, `ce_`, `cc_`, `wk_`, browser
sessions) and refuses any request that carries a browser `Origin`.

## Enrollment and management

Organization managers use the browser session with `organization.manage`:

- `POST /platform/v1/orgs/{orgId}/workers` creates a pending worker with a name
  and purposes (`build`, `function`) and returns the `we_` code once. It needs a
  fresh session and an idempotency key; a retry is refused with 409.
- `GET /platform/v1/orgs/{orgId}/workers` lists workers with status,
  capabilities and last-seen time.
- `POST /platform/v1/orgs/{orgId}/workers/{workerId}` runs `disable`, `enable`
  or `revoke`. Disabling or revoking ends the worker's claimed leases at once and
  re-offers their work. Revocation is permanent and clears the credential hash.

The worker calls `POST /worker/v1/enroll` with the code and its capabilities
(platform, architecture, toolchains) and receives its `wc_` credential. One
caller may make ten enrollment attempts per 15 minutes; further attempts are
refused with 429 even with a valid code. The counter is a keyed digest, so no
address is stored.
`POST /worker/v1/credential` rotates it; the previous credential stops at once.

Every worker call re-checks that the worker is active, its credential is
unexpired and its organization is active.

## Leases

A lease is one subject (a build or a function execution), one environment, a
named list of secrets, and a deadline. Leases are granted only by
`WorkerLeases.grant` inside Cloud. There is no HTTP route for it, so a browser
session or an API credential cannot grant itself a lease. Creating a build
([builds.md](builds.md)) grants one in the same transaction as the build.

1. **Grant.** The environment must be active and every named secret must exist
   and be active. One subject has one open lease.
2. **Claim.** `POST /worker/v1/leases/claim` gives the worker the oldest lease
   offered to its organization that matches its purposes and platform, with a
   `wl_` token. Workers in other organizations are never offered it.
3. **Heartbeat.** `POST /worker/v1/leases/{id}` with `{"kind":"heartbeat"}`
   every 20 seconds renews a 60-second window, never past the deadline, and
   reports cancellation.
4. **Complete.** `{"kind":"complete"}` ends the lease.

Lease calls carry the `wc_` credential as the bearer token and the `wl_` token
in `x-carbon-lease-token`.

## Secret delivery

`POST /worker/v1/leases/{id}/secrets` returns the current value of each secret
the lease names, and nothing else in the environment.

- **Once.** A second request for the same lease is refused with 409, even with
  the right token. If the response is lost, the lease is abandoned and retried
  as a new attempt.
- **All or nothing.** If any named secret is missing or disabled, no value is
  returned.
- **Live checks.** The lease must be claimed by this worker, carry this lease
  token, be inside its window, and not be cancelled; the environment and project
  must be active.
- **Custody failure.** If the key store refuses or cannot be reached, nothing is
  delivered and the lease can still be delivered once custody recovers.
- **No copies.** Values are not stored, logged or written to events. The
  `lease.secrets_materialized` event records names and versions only.

The response's `expiresAt` is the lease deadline. A worker must discard the
values when the lease ends.

## Cancellation, expiry and worker loss

- **Cancellation.** `WorkerLeases.cancel` cancels a subject's open leases. The
  next heartbeat reports it; the lease can no longer deliver secrets or
  complete.
- **Expiry.** A lease whose window passed is dead even to its own token.
- **Worker loss.** A claimed lease that expires gets a successor lease with the
  next attempt number, a new identifier and a new token, until the attempt limit
  (default 3) or the deadline. The old token never works again. An offer nobody
  claimed lapses without a retry.
- **Sweeper.** `bun run --cwd products/carbon-cloud worker-lease-sweeper`
  expires overdue leases and creates successors every five seconds. It needs
  only the Cloud database and never decrypts anything. After each sweep it also
  ends builds and function executions that can no longer finish, and fires
  function schedules that are due ([functions.md](functions.md)).

## Not included

- A worker that ends a build or function lease with the plain lease `complete`
  command, instead of the build's or function's own, leaves the subject to be
  failed by the sweeper.
- The legacy `wk_` worker tokens and the legacy build queue routes are unchanged
  and are not connected to enrolled workers.
- Authenticated worker calls are not rate limited; only enrollment attempts are.
- Worker attestation, network isolation and workspace erasure belong to the
  Windows execution phase.

## The build worker

The process that enrolls, claims build leases and runs them is described in
[build-worker.md](build-worker.md).
