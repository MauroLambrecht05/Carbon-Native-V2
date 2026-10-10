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

## Hosted custody in AWS KMS

`CARBON_SECRET_CUSTODY=aws-kms` keeps the wrapping key in AWS KMS. Each data key
is wrapped and unwrapped with KMS `Encrypt` and `Decrypt`; the wrapping key never
leaves KMS. The secret and version identity is sent as KMS encryption context, so
a wrapped key cannot be unwrapped for a different secret or version.

```dotenv
CARBON_SECRETS=enabled
CARBON_SECRET_CUSTODY=aws-kms
CARBON_SECRET_KMS_REGION=eu-west-1
CARBON_SECRET_ACTIVE_KEY_ID=2026-10
CARBON_SECRET_KMS_KEYS={"2026-10":"arn:aws:kms:eu-west-1:111122223333:key/..."}
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

`CARBON_SECRET_KMS_KEYS` maps Carbon key IDs to KMS key ARNs, key IDs or
aliases. To rotate, add a new entry and make it the active ID; keep old entries
for as long as envelopes written under them exist. Selecting `aws-kms` requires
every variable above and never falls back to the local keyring. KMS error bodies
are not logged or returned. Moving existing envelopes between custody modes is
not implemented: choose the mode before storing secrets.

The adapter is tested against the published AWS Signature Version 4 example and
a KMS stand-in. It has not been run against a real AWS account.

## Delivery to workers

Account mail and staged import keys remain separate. Secret values are
decrypted in exactly one place: delivery to an enrolled worker that holds a
lease naming those secrets, once per lease. See [workers.md](workers.md). No
browser route, data route or other credential type can decrypt them.
