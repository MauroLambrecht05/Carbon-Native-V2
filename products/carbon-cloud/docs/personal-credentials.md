# Personal credentials

A personal credential is a `pt_` token that a signed-in account creates for
itself. It carries one exact scope and a short list of permissions the account
holds at that scope. The wire contract is in
[personal-credential-api.openapi.json](personal-credential-api.openapi.json);
storage is Cloud migration `0021_personal_credentials.sql`.

## Management

All routes use the browser session, the configured Origin and CSRF.

| Route | Purpose |
|---|---|
| `GET /platform/v1/account/personal-credentials` | Metadata page for the signed-in account only |
| `POST /platform/v1/account/personal-credentials` | Create; returns the token once |
| `POST /platform/v1/account/personal-credentials/{id}` | `rotate` (returns a new token once) or `revoke` |

Creation and rotation require a fresh session and an idempotency key. Rotation
and revocation also require the credential's current revision in `If-Match`.

- **One-time disclosure.** The token appears only in the response that created
  or rotated it. A retried create or rotate with the same idempotency key is
  refused with 409 instead of showing a token again. A retried revoke returns
  the same receipt.
- **Hash-only storage.** Cloud stores the SHA-256 hash and an 11-character
  display prefix. Pages, receipts, events and command records never contain the
  token or its hash. Revocation clears the hash.
- **Bounded scope.** The scope is an organization, project or environment the
  owner can read. Permissions come from the environment-credential set
  (`metadata.read`, `resources.configure`, `data.read`, `data.write`,
  `release.publish`) and the owner must hold each one at that scope when the
  credential is created and again when it is rotated. Organization and member
  management cannot be delegated.
- **Bounded lifetime.** Expiry is required and at most 90 days away. An account
  can hold 20 active credentials. An active name is unique per account.
- **Tenant isolation.** Another account cannot list, rotate or revoke the
  credential and receives 404 for its identifier. Scopes in organizations the
  caller does not belong to are reported as not found.

## Verification

`PersonalCredentialAuthentication.verify(token, scope, permission)` accepts a
token only when all of these hold:

- the requested scope equals the credential's scope exactly;
- the permission is one the credential lists;
- the credential is active and unexpired;
- the account, organization, membership and any project or environment are
  active;
- the account's permission revision still equals the one recorded at creation
  or last rotation.

The last rule means any change to the owner's access suspends the credential
until the owner rotates it, and rotation re-checks the delegated permissions.
Successful verification updates `lastUsedAt`.

## Boundary

Personal credentials are not yet exchangeable for Database or Registry
assertions, and the CLI does not use them. Device (`dc_`) and service-account
(`cs_`) credentials remain the only inputs to those exchanges. Worker
credentials are Phase 4.
