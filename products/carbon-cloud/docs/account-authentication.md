# Account authentication and email delivery

The email account API is a real PostgreSQL-backed implementation, enabled with
`CARBON_ACCOUNT_AUTH=enabled`. It does not use the browser mock services or the
legacy organization-token/app-user authentication model. Endpoint contracts are
in [account-api.openapi.json](account-api.openapi.json).

Configure the variables in the product's `.env.example`. Use a verified Resend
sender and a sending API key. `CARBON_PUBLIC_ORIGIN` is the exact public origin,
without a trailing slash or path; HTTPS is required in production. Behind TLS
ingress, preserve the public Host header and restrict access to the backend
listener. Forwarded headers are not accepted as identity or trusted client IP.
Rate limiting uses the actual socket peer and normalized email, HMAC-protected
before storage; a reverse proxy's clients share its peer limit.

Generate independent random 32-byte keys for `CARBON_ACCOUNT_RATE_KEY` and the
account encryption keyring. Store them outside source control in the
deployment secret store. The keyring JSON maps IDs to base64-encoded keys;
`CARBON_ACCOUNT_ACTIVE_KEY_ID` selects the key for new encrypted values.
Keep retiring keys while any pending email or pending/active MFA factor still
uses them, and allow outstanding session-list cursors to expire. Draining email
alone is insufficient: MFA secrets persist until replacement or disable. An
automated factor rewrapping job is not yet implemented. Each value uses a fresh
AES-GCM data key wrapped by the configured key and bound to its challenge,
factor, or session-list context. Changing its context or key ID invalidates authentication. This is
the explicit self-hosted custody adapter; managed KMS/HSM custody still needs
implementation and verification before hosted production cutover.

After exporting environment variables, run:

```sh
bun run --cwd products/carbon-cloud migrate
bun products/carbon-cloud/main.ts
```

Run the durable email worker as a separate process with the same account and
database configuration:

```sh
bun run --cwd products/carbon-cloud account-mail-worker
```

The worker claims one message with a bounded lease. Another worker can reclaim
it after process loss. Retries preserve the original encrypted message and
provider idempotency key. Successful delivery and expiry erase the encrypted
payload. Neither provider errors nor queue errors log message content. Email
challenges expire after 15 minutes; the worker does not claim expired jobs.
Delayed provider delivery does not extend a proof's validity.

For local development, explicitly set `NODE_ENV=development`, select
`CARBON_ACCOUNT_EMAIL_PROVIDER=development-inbox`, and set
`CARBON_ACCOUNT_INBOX_DIRECTORY`. Files in that directory contain readable
development links and must stay private and uncommitted. The inbox is never
selected as a fallback when Resend fails and is rejected in production.

## Browser protocol

1. GET `/platform/v1/auth/bootstrap` with same-origin credentials. It sets an
   HttpOnly browser-proof cookie and returns the current terms version.
2. POST `/platform/v1/auth/challenges` with JSON, `Origin` and a fresh
   `Idempotency-Key`. Registration must explicitly accept the current terms and
   include the exact `termsVersion` returned by bootstrap.
   The generic 202 receipt does not reveal account existence or a magic link.
3. Read the delivered link in the requesting browser. The token is in its URL
   fragment, so it is not sent in an HTTP URL/referrer. The eventual production
   page must erase the fragment immediately and POST the token to
   `/platform/v1/auth/complete`; visiting the link alone never consumes it.
4. Successful completion creates a verified account only for registration,
   consumes the challenge, issues an eight-hour opaque session and records
   security events in one transaction. A challenge cannot be used in a different
   browser or consumed twice. Tokens are stored only as hashes; encrypted email
   outbox payloads are the short-lived delivery exception.
5. GET `/platform/v1/account/session` returns a safe projection or null, after a
   live state/revision/expiry/revocation check. No token or CSRF hash is returned.
6. POST `/platform/v1/auth/signout` with `Idempotency-Key` and `X-CSRF-Token` read
   from the `__Host-carbon-csrf` cookie. The server checks the session's stored
   hash, then atomically revokes and audits. The session cookie remains HttpOnly.

Cookies are Secure, host-only and SameSite=Lax on HTTPS. Loopback HTTP
development uses unprefixed cookie names. Every mutation requires the configured
Origin, and all responses use no-store and request IDs. Bodies are bounded to
8 KiB. No localStorage bearer credential is introduced.

After an ambiguous one-time completion response, inspect the current session;
if no session cookie arrived, request another challenge. Do not blindly retry a
consumed credential or persist session plaintext in an idempotency receipt.

Recovery verifies the delivered proof plus active MFA, increments account
security revision and revokes previous sessions before creating a new session.
When MFA is active, completion without `code` returns 401 with
`error.fieldErrors.code = "mfa_required"`; retain the challenge in memory and
submit it with a TOTP or unused recovery code. Missing or incorrect MFA never
consumes the email challenge or issues a session. After an incorrect proof,
account-wide failed attempts commit even though the HTTP request fails. Five
failures lock further MFA attempts for 15 minutes across challenges and servers.

## Account security and sessions

GET `/platform/v1/account/sessions` returns active sessions for the authenticated
account, including device label, creation/expiry, current-session flag and MFA
verification. Device labels come from the user agent and are descriptive only.
There are no token, CSRF or factor values in this projection. Pagination uses
`limit` (1–100, default 25), ascending ID order and an opaque `cursor`. Cursors
expire after 15 minutes and bind the session, account revision and page size.
Restart the list after any account session/security mutation; a cursor cannot
be reused by another session or account. Expired/revoked sessions are excluded.

POST `/platform/v1/account/security` accepts a shared `AccountSecurityCommand`.
Send `Origin`, `Idempotency-Key`, `X-CSRF-Token` and `If-Match` containing the
current `session.account.revision` (also returned by the list). The account lock,
authorization/revision checks, mutation, audit and safe receipt commit together.
Commands other than rotation require authentication within the last 10 minutes.
Use the session-bound fresh-auth flow below when a command returns 403 with
`error.fieldErrors.authentication = "fresh_required"`.

| Command | Behavior |
| --- | --- |
| `mfa-start` | Replaces a pending enrollment and returns its factor ID, base32 secret and otpauth URI once. Enrollment expires in 10 minutes. |
| `mfa-confirm` | Requires the pending factor ID and a valid TOTP. Activates the factor and returns ten recovery codes once. |
| `recovery-reset` | Requires TOTP or an unused recovery code; invalidates every old recovery code and returns ten replacements once. |
| `mfa-disable` | Requires TOTP or an unused recovery code; denies disable when an active membership's organization requires MFA. Clears the encrypted factor secret and invalidates recovery codes. |
| `session-rotate` | Replaces the current session/CSRF cookies while preserving absolute expiry and existing freshness. |
| `session-revoke` | Revokes the specified session of this account. Use sign-out for the current session. |
| `sessions-revoke-others` | Revokes every other session of this account. |

MFA confirmation, replacement of recovery codes and disable increment the
security revision, revoke all old sessions and issue replacement cookies to the
actor. This replacement preserves the original eight-hour absolute expiry.
TOTP uses a random 160-bit secret, six digits and 30-second counters with one
counter of clock tolerance. Each accepted counter can be used only once; the
counter and recovery-code consumption are protected by the account transaction
lock. Recovery codes contain 128 random bits and are stored only as hashes.
Reference vectors come from [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238).

Do not log or persist enrollment/recovery response values in browser storage.
The durable command receipt omits secrets and reports
`oneTimeValuesUnavailable: true` on an enrollment retry. Commands that replace
the session invalidate the old cookie, so a lost cookie response requires a new
login. If recovery-code delivery was lost, use the authenticator to sign in and
generate a replacement set. Plaintext session or recovery values are never
stored to make a retry recover them.

## Fresh authentication

1. With a valid session, GET `/platform/v1/auth/bootstrap` to obtain the browser
   proof cookie. POST `/platform/v1/account/fresh-auth/challenges` with an empty
   JSON object (or optional same-origin `returnTo`), `Origin`, `Idempotency-Key`
   and the current session's `X-CSRF-Token`.
2. The server sends the proof to the current account's verified email through
   the same encrypted outbox and worker. It accepts no caller-supplied email or
   account/session ID. Identical retries enqueue once. The challenge binds the
   browser, session and account security revision and expires in 15 minutes or
   at the session's original expiry, whichever comes first.
3. The delivered link targets `/auth/fresh#token=...`. The eventual production
   page must immediately erase the fragment and POST the token to
   `/platform/v1/account/fresh-auth/complete` with `Origin`, the original
   session/CSRF and browser proof. An enrolled account must supply a new TOTP or
   unused recovery code. Missing MFA leaves the challenge available for the next
   submission; invalid proofs still increment the shared durable attempt limit.
4. Completion consumes the challenge, revokes the old session and issues new
   HttpOnly session/CSRF cookies in the same audited transaction. It restores ten
   minutes of freshness, capped at the original absolute expiry. Other sessions
   stay valid. Refresh the account revision before retrying the sensitive action.

A fresh-auth proof cannot log in through the public completion endpoint, and a
regular login proof cannot be substituted for it. Session revocation, rotation,
expiry or an account security-revision change invalidates the pending context.
Two simultaneous completions cannot both succeed. If the cookie response is
lost, inspect the current session; request a new login if no replacement cookie
arrived. Completion receipts never store plaintext replacement credentials.

## Profile and verified-email changes

GET `/platform/v1/account/profile` returns the account and any live pending email
change. The session projection also contains the display name and `avatar` text.
Render the avatar as text (initials or emoji), never as a remote URL or HTML.

POST `/platform/v1/account/profile` with `Origin`, `Idempotency-Key`,
`X-CSRF-Token` and the current account revision in `If-Match`:

- `{ "kind": "update", "name": "New name", "avatar": "🌿" }` saves immediately.
  Names are trimmed, nonempty and at most 100 characters; avatars contain at most
  eight characters. Control characters and extra privilege/identity fields fail.
  This ordinary profile edit does not require fresh authentication.
- `{ "kind": "email-change", "email": "new@example.com" }` requires fresh
  authentication and the browser proof from `/platform/v1/auth/bootstrap`. It
  supersedes prior pending changes and returns a generic 202 receipt. The current
  address stays verified until completion; the recipient comes from the requested
  normalized address. Conflicting linked identities are refused at verification.
- `{ "kind": "email-cancel" }` requires fresh authentication and cancels the
  pending change. Cancellation and supersession clear queued delivery payloads;
  already delivered or in-flight mail can arrive, but its old proof cannot work.

The encrypted verification message targets `/account/email/verify#token=ec_...`.
The eventual production page must erase this fragment immediately, then POST
`{ "token": "ec_...", "code": "..." }` to
`/platform/v1/account/email/complete` with the original browser/session cookies,
`Origin` and `X-CSRF-Token`. The optional code becomes required when MFA is active;
it must be a new accepted TOTP counter or unused recovery code. Email proof is
valid for 15 minutes at most and is bound to session and account security revision.

Completion acquires the same email-identity locks as registration/login, rejects
already linked addresses, and preserves the account ID. It replaces the email
identity and verified address, increments security revision, revokes all previous
sessions and pending sign-in challenges for the old/new address, and issues new
session/CSRF cookies with the original absolute expiry. A notice to the previous
address is committed into the encrypted outbox and retried for up to 24 hours.
Requests, cancellation, profile edits and completion all leave safe audit events.
Neither command receipts nor the profile view contain proof or session values.

If a completion response is lost, inspect the current session. If no replacement
cookie arrived, sign in with the new verified address. Old proofs and old cookies
cannot recover a plaintext replacement credential from a stored receipt.

Organization creation, membership administration, MFA policy and ownership
transfer are documented in [organization-access.md](organization-access.md).
Invitations use the same account and mail composition; see
[organization-invitations.md](organization-invitations.md).
GitHub registration/sign-in and explicit identity linking/unlinking are available
through the configured [GitHub protocol](github-account-authentication.md).
Scoped grants, account deletion and the production browser adapter remain incomplete.

## Verification

The integration suite uses real PostgreSQL plus a captured Resend transport. It
checks concurrency, restart/retry, lease recovery, generic responses, expiry,
revocation, CSRF, redirects, redaction, size limits and persistent rate limiting.
MFA cases cover independent RFC vectors, enrollment expiry/replacement, lockout
and replay persistence, concurrent challenges, recovery replacement, organization
policy, session rotation and cross-account session/cursor isolation.
Fresh-auth cases cover proof-purpose separation, cross-account/session/browser
substitution, stale authority, expiry, cookie rotation without lifetime extension,
required MFA, concurrent consumption and durable request deduplication.
Profile/email cases cover CSRF/revision checks, idempotent writes, local avatars,
provider retry, encrypted notices, identity conflicts, cancellation/supersession,
MFA, account/browser/session binding and concurrent verification.
It does not send email to real recipients or claim live Resend delivery evidence.
The production completion page is not yet wired; these endpoints are available
for API integration behind the explicit rollout flag.
