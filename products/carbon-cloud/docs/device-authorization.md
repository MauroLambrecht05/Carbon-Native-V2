# Device authorization and CLI credentials

The device flow lets a CLI request narrow access without receiving a browser
session. Its wire contract is documented in
[device-authorization-api.openapi.json](device-authorization-api.openapi.json).

The CLI creates a ten-minute authorization request and receives a random `dv_`
device code, a short user code, the browser verification URI and a five-second
poll interval. The public create and poll endpoints accept JSON bodies up to 8
KiB, pin the configured host, reject foreign browser origins and rate-limit
requests without storing client addresses. Carbon stores only SHA-256 digests of
both codes.

After signing in, the user enters the short code and sees the requesting client,
device, exact organization/project/environment scope and permissions. Approval
requires a fresh session, CSRF, an idempotency key, the current request revision,
`metadata.read` on the scope and every permission being delegated. Denial has the
same concurrency and replay guarantees. Expired, denied and consumed requests do
not disclose account details.

The first successful poll after approval returns a `dc_` token and grant metadata.
The token is never returned again. Persistence keeps its SHA-256 hash and display
prefix; pages, receipts, events and errors contain no plaintext credential.
Credentials expire after 30 days and are accepted only for their exact scope and
listed permissions while the account, membership and scoped resources remain
active and the account permission revision still matches. Revocation clears the
stored hash and takes effect on the next verification.

Carbon CLI now drives this flow with `carbon cloud login`, stores the `dc_`
credential through `Bun.secrets` in the operating system credential store, and
keeps only token-free profile metadata in `~/.carbon/device-profile.json`.
`carbon cloud logout` removes both the secure credential and local metadata.

For `carbon db data`, Cloud authenticates the device credential and issues a
60-second Ed25519 assertion with an `account`/`cli` principal. The assertion is
bound to the exact Database audience, environment, permission, POST path and
SHA-256 digest of the canonical request body. Carbon Database verifies that
binding and rechecks the device grant, account, membership, resources,
permission revision and Database binding through live Cloud authority. Revoking
the grant therefore blocks both new exchanges and already issued assertions.

Registry has its own exchange at `POST /platform/v1/device/registry-assertions`
with the `DeviceRegistryAssertionExchange` contract. It accepts only the
`carbon-registry` audience and canonical `/registry/` request paths; the
Database exchange accepts neither. Carbon Registry verifies the audience and
request binding, then asks Cloud's live authority to recheck the grant and the
exact Registry binding. A Database assertion is refused by Registry, a Registry
assertion is refused by Database, and revoking the grant blocks both the
exchange and assertions already issued. The first canonical Registry request is
`namespace.get`, which returns the environment's reserved namespace and requires
`metadata.read`. The CLI does not call it yet.

Personal and worker credentials remain separate later work.
