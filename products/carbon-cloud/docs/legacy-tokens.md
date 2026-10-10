# Legacy `cc_` tokens: migration and deprecation

Self-hosted v1 gave every organization one `cc_` organization token at signup
(`POST /v1/orgs`) and let that token mint `wk_` worker tokens. Both live in
`api_tokens` (migration 0002). They are organization-wide, never expire and are
not tied to a person. This document is the path off them. The wire contract is
in [legacy-token-api.openapi.json](legacy-token-api.openapi.json).

## What changed in storage

Migration `0021_personal_credentials.sql` only adds to `api_tokens`: `status`
(`active` or `retired`, default `active`), `last_used_at`, `retired_at`,
`retired_by`, `replaced_by_service_account` and `revision`. Existing rows keep
their hash and stay accepted. No owner, membership, slug or scope is inferred
for a legacy organization.

## Deprecation stages

`CARBON_LEGACY_TOKENS` selects the stage. Unset means `issue`, which is the
behavior before this change. `CARBON_LEGACY_TOKEN_SUNSET` (a date) adds a
`Sunset` header in the `warn` stage.

| Stage | `POST /v1/orgs` signup | `cc_` organization tokens | `wk_` worker tokens |
|---|---|---|---|
| `issue` | open | accepted | accepted |
| `accept` | 410 | accepted | accepted |
| `warn` | 410 | accepted; every response carries `Deprecation: true` (and `Sunset`) | accepted |
| `reject` | 410 | 401 | accepted |

Carbon Database and Carbon Registry verify legacy tokens through Cloud's
`/v1/auth/verify`, so the stage applies to them without a change on their side.
Worker tokens are outside this policy. Enrolled workers ([workers.md](workers.md))
exist, but the legacy build queue still authenticates with `wk_` until build
orchestration moves to leases (Phase 7).

## Owner path

1. **Claim the organization.** A signed-in account posts an active `cc_`
   organization token and a slug to `POST /platform/v1/account/legacy-claims`.
   Holding the token is the proof of control. The account becomes the Owner and
   the organization becomes a normal managed organization. The claim needs a
   fresh session, CSRF and an idempotency key. An organization that already has
   any member cannot be claimed again, by anyone, with any token.
2. **Review usage.** `GET /platform/v1/orgs/{orgId}/legacy-tokens` lists the
   organization's legacy tokens with kind, status, creation time and
   `lastUsedAt`, plus the current stage. It never returns a hash. It requires
   `organization.manage`. Usage is recorded at most once a minute per token.
3. **Replace.** Create a managed service account
   ([service-accounts.md](service-accounts.md)) or personal credentials
   ([personal-credentials.md](personal-credentials.md)) for whatever still uses
   the token.
4. **Retire.** `POST /platform/v1/orgs/{orgId}/legacy-tokens/{tokenId}` with
   `{"kind":"retire"}` stops the token authenticating at once. An optional
   `replacedByServiceAccountId` records its replacement and must name an active
   managed service account in the same organization. Retirement needs a fresh
   session, `organization.manage`, the token's revision and an idempotency key.

Claim, retire and restore each write a `legacy_token_events` row that contains
no token or hash.

## Rollback

Every step can be undone without data loss:

- **A stage** is rolled back by setting `CARBON_LEGACY_TOKENS` to the earlier
  value and restarting Cloud. No data changes with the stage.
- **A retired token** is restored with `{"kind":"restore"}` on the same route.
  Retirement keeps the hash, so the original token works again.
- **The migration** is additive. Code from before 0021 ignores the new columns
  and treats every row as accepted, including retired ones, so retire tokens
  only once you no longer intend to roll the release back.
- **A claim** is not reversed by this API. Use the normal organization
  ownership transfer if the wrong account claimed.

## Not included

Hash deletion after a published expiry window, an operator view across
organizations, automatic conversion of a token's grants into a service account,
and migration of `wk_` worker tokens are not implemented.
