# GitHub account authentication

The real account platform now supports GitHub registration, sign-in, explicit
linking, identity listing and unlinking. The HTTP contract is
[github-account-api.openapi.json](github-account-api.openapi.json), with identity
management also included in [account-api.openapi.json](account-api.openapi.json).

Enable `CARBON_ACCOUNT_AUTH=enabled` and its existing database, mail and encryption
configuration. Separately set `CARBON_ACCOUNT_GITHUB=enabled`,
`GITHUB_ACCOUNT_CLIENT_ID` and `GITHUB_ACCOUNT_CLIENT_SECRET`. Register a dedicated
GitHub OAuth app with the exact callback
`${CARBON_PUBLIC_ORIGIN}/platform/v1/auth/github/callback`. This client is separate
from future repository-installation credentials. Missing provider configuration
returns `capability`; an enabled but incomplete configuration fails startup.
Bootstrap reports `githubAvailable` for browser capability discovery.

GitHub documents OAuth authorization code with S256 PKCE and authenticated user/
email APIs for this flow. The implementation uses those provider checks; it does
not invent an OIDC ID token. The immutable numeric GitHub user ID is the identity
key, and a verified primary GitHub email is required. Provider access/refresh
tokens remain inside the adapter and are never returned or persisted. See
[GitHub's flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[user API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user),
and [email API](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user).

## Browser protocol

1. GET `/platform/v1/auth/bootstrap` to establish the HttpOnly browser-proof
   cookie. POST `/platform/v1/auth/github/start` with Origin, `Idempotency-Key`
   and a purpose: `registration`, `login` or `link`. Registration requires current
   terms consent. Link additionally requires the current session, CSRF and fresh
   authentication. `returnTo` must be a bounded relative path on the configured
   origin; it can retain an invitation route/fragment.
2. Navigate to the returned `authorizationUrl`. The state and PKCE verifier are
   encrypted at rest; only the state hash is used for lookup. An exact retry while
   pending returns the same URL. Changed reuse, expired state or an already
   claimed request requires a new idempotency key. Durable browser/peer and, for
   linking, account limits allow 20 starts per 15-minute window.
3. GitHub returns to the exact callback with `state` and either `code` or `error`.
   Only this GET endpoint permits the provider's cross-site redirect. It checks
   single-use state and the bound browser cookie, consumes state before exchange,
   decrypts the verifier and exchanges the code once. Linked-account flows also
   recheck the original live session and security revision. Redirect targets,
   provider errors and unknown/duplicate parameters cannot change the callback.
4. Successful provider verification persists an encrypted identity and redirects
   with HTTP 303 to `/auth/github/complete#token=go_...`. No Carbon account or
   session is created at this point. The continuation binds the original browser,
   purpose, original ten-minute deadline, resolved account and security revision.
5. POST `{token, code?}` to `/platform/v1/auth/github/complete` from that browser.
   `code` is a Carbon TOTP or one-time recovery code when required. Link completion
   also requires the original account session and current CSRF token. Successful
   completion consumes the continuation, issues Secure HttpOnly session and CSRF
   cookies and clears the browser-proof cookie. Return `{returnTo, linked}` to
   the router. Do not blindly retry a successful or ambiguous one-time response;
   inspect the session or start authentication again if its cookie was lost.

All responses are no-store with no-referrer policy. Keep authorization URLs,
callback query strings and continuation fragments out of application telemetry.
Ingress access logging must redact the GitHub callback's query, which contains a
temporary authorization code and state. The production browser pages remain part
of the pending real browser adapter; these APIs are available for integration.

## Linking and session rules

A new registration can create a verified account and email/GitHub identities only
when neither identity belongs to an existing account. Matching email alone never
merges or silently links accounts: sign in by email and explicitly link GitHub.
Linking proves both the live Carbon session and GitHub identity, and requires the
current verified Carbon email among GitHub's verified addresses. A subject cannot
belong to two accounts, and each account can have only one GitHub identity.

Later sign-in resolves the immutable provider subject. Provider email/name changes
do not silently replace the Carbon profile or verified sign-in email. Carbon MFA
is always enforced independently; GitHub's two-factor flag is not accepted as
Carbon MFA. Failed codes commit their shared account lockout state. Recovery
codes remain one-use. Revocation, recovery, MFA changes and unlinking invalidate
already verified continuations through the account security revision.

Linking advances security/profile revisions, revokes existing sessions and rotates
the actor's cookies while preserving original absolute expiry. Session issuance,
identity changes, proof consumption and account-security events commit together.
Provider-subject/email advisory locks and account-before-flow row locks serialize
registration, linking, email changes, MFA and completion. A process lost after
claiming state requires a new flow; a restart after verification can complete the
persisted continuation without another provider exchange.

GET `/platform/v1/account/identities` lists only the caller's provider, subject,
verification timestamp and `canUnlink` with the current account revision. POST
`identity-unlink` with `identityId` to `/platform/v1/account/security`, using its
CSRF, If-Match, fresh-auth and idempotency protocol. Active MFA additionally
requires a new accepted TOTP or recovery code. Unlinking GitHub requires a usable
verified email identity; the final sign-in method cannot be removed. Primary
email changes use the existing profile verification flow. Unlinking revokes old
sessions and pending verified contexts and rotates the actor's cookie. It removes
the Carbon identity binding; it does not claim to revoke the user's GitHub OAuth
app authorization itself.

Migration 0012 adds durable flow storage and per-account GitHub uniqueness without
changing existing verified subjects. The account mail worker also expires bounded
batches of abandoned flows and erases their encrypted payloads, including when
GitHub has subsequently been disabled. No migration fabricates provider links.

Integration tests use real PostgreSQL and captured GitHub/Resend transports. Live
GitHub consent, production callback ingress and browser cutover are deployment
evidence still to gather with configured credentials.
