# Environment secrets

Environment secrets are named, versioned values scoped to one canonical
environment. The metadata-only account API is documented in
[environment-secrets-api.openapi.json](environment-secrets-api.openapi.json).

Creating a secret writes logical metadata and immutable version 1 in one
transaction. Rotating appends a new immutable version and advances the current
version. Disabling prevents later worker materialization without deleting audit
or encrypted version history; enabling does not create a version. Names use
uppercase environment-variable form such as `DATABASE_URL` and are unique inside
an environment.

Every version receives a random 256-bit data key. AES-256-GCM binds ciphertext to
the secret and version identity. A separate custody adapter wraps that data key
and records its key ID next to the envelope. The included local AES custody
adapter is explicit self-hosted configuration. Hosted deployments implement the
same `SecretKeyCustodian` port with KMS/HSM operations. Rotation keyrings can read
old envelopes while writing new versions under the active wrapping key.

The browser sends secret values only in create or rotate request bodies. Values,
envelopes and wrapping-key identifiers never appear in account responses,
receipts, events or error details. Requests are limited to 64 KiB after UTF-8
encoding. All writes require same-origin session and CSRF, fresh
`resources.configure` authority, idempotency, and a current revision. Create uses
the environment revision; commands use the secret revision. Exact retries return
the same safe metadata receipt.

Enable the self-hosted adapter explicitly:

```dotenv
CARBON_SECRETS=enabled
CARBON_SECRET_ACTIVE_KEY_ID=2026-09
CARBON_SECRET_ENCRYPTION_KEYS={"2026-09":"BASE64_32_RANDOM_BYTES"}
```

Account mail and staged import keys remain separate. Build/function lease
authorization and short-lived materialized bindings are still required before a
worker may receive values; no browser or generic data route can decrypt them.
