# Environment credentials

Environment credentials are narrow automation tokens bound to one canonical
organization, project and environment. The account API routes and exact wire
contracts are documented in
[environment-credentials-api.openapi.json](environment-credentials-api.openapi.json).

Create and rotate return a `ce_` token exactly once. Carbon stores its SHA-256
hash, an eight-character display suffix after `ce_`, the automation audience,
permissions, expiry and audit metadata. List, command receipts, events and error
bodies contain no plaintext token or token hash. A repeated create or rotate
idempotency key cannot recover the token and returns a conflict; it also cannot
create a second credential. Save the first successful response in the intended
secret manager before continuing.

Credentials can grant `metadata.read`, `resources.configure`, `data.read`,
`data.write`, or `release.publish`. Creation requires the human actor to have
`resources.configure` and every delegated permission at the exact environment.
All changes require same-origin browser session, CSRF, fresh authentication,
`Idempotency-Key`, `If-Match`, and `X-Request-Id`. Creation matches the environment
revision; rotation and revocation match the credential revision. Expiry must be
in the future and no more than 366 days away.

Rotation keeps the logical credential ID and increments its revision. Its prior
token may overlap for zero to 86,400 seconds, capped by the prior token expiry.
Only the immediate prior token can overlap; another rotation removes earlier
overlap material. Revocation removes all overlaps and rejects current and prior
tokens immediately. Verification also rejects expired credentials, missing
permissions, another environment scope, inactive organizations/projects, and
deleted environments. Successful verification records only `lastUsedAt`.

Example creation:

```http
POST /platform/v1/orgs/{orgId}/projects/{projectId}/environments/{environmentId}/credentials
Origin: https://cloud.example.com
X-CSRF-Token: ...
Idempotency-Key: ...
If-Match: "3"
Content-Type: application/json

{"name":"CI release","permissions":["metadata.read","release.publish"],"expiresAt":"2026-12-01T00:00:00.000Z"}
```

This slice provides Cloud issuance and live verification. CLI device
authorization, personal and service-account tokens, worker enrollment, and
conversion into downstream service assertions remain separate BE-05/BE-06 work.
