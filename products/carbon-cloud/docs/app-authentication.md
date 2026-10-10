# Application authentication

Application authentication signs in an app's own end users. It is separate from
Carbon accounts, which are the developers. Each environment has at most one
realm, which holds that environment's users, sign-in policy and sessions. The
wire contract is in [app-auth-api.openapi.json](app-auth-api.openapi.json);
storage is Cloud migration `0024_app_realms.sql`.

## Realm administration

Developers use the browser session. Reading needs `metadata.read`; changing
needs `resources.configure`, a fresh session, CSRF and an idempotency key.

| Route | Purpose |
|---|---|
| `GET .../environments/{id}/realm` | The realm, or 404 before it is configured |
| `POST .../environments/{id}/realm` | A realm command |
| `GET .../environments/{id}/realm/users` | App users |
| `POST .../environments/{id}/realm/users/{userId}` | `suspend`, `restore`, `delete`, `revoke-sessions` |

Realm commands:

- `configure` creates the realm the first time and updates it afterwards:
  whether signup is open, whether email sign-in is enabled, the session lifetime
  (5 minutes to 30 days) and the redirect allowlist.
- `state` disables or re-enables the realm. A disabled realm serves nothing.
- `invalidate-sessions` raises the realm's claims revision, which ends every
  session, every outstanding assertion and every pending sign-in at once.
- `provider-set` and `provider-remove` manage OIDC providers.

Any change to a realm cancels sign-ins that were started under the old
configuration.

The redirect allowlist is exact-match: no wildcards, no fragments, no embedded
credentials, and plain `http` only for a local development callback.

Suspending, deleting or revoking a user ends their sessions. Restoring a user
does not bring old sessions back. A deleted user's address can sign up again as
a different user.

## The app-facing API

These routes are under `/app/v1/realms/{realmId}` and are called by the
customer's app. They read no Carbon cookie; an end user is authenticated only by
the `aps_` session token in `Authorization`.

| Route | Purpose |
|---|---|
| `GET /configuration` | Whether signup and email sign-in are on, and provider names |
| `POST /challenges` | Ask for an emailed sign-in link |
| `POST /sessions` | Exchange a link token for a session |
| `GET /session` | The signed-in user |
| `POST /session/rotate` | Replace the session token |
| `DELETE /session` | Sign out |
| `POST /oidc/start`, `POST /oidc/complete` | Sign in with an OIDC provider |
| `POST /assertions` | Exchange the session for a Database assertion |

### Email sign-in

`POST /challenges` always answers 202 with the same body. It does not reveal
whether the address has an account, whether it may sign up, whether it is
suspended, or whether mail was sent. A link is sent only to an active user, or to
a new address when signup is open. The link is the allowed redirect URI with
`#token=am_...`; it works once and expires in 15 minutes. Only its hash is
stored, and the message is encrypted in the outbox until the mail worker
delivers it.

Limits per realm, per 15 minutes: 20 requests from one caller (then 429) and 5
links to one address (then the same 202, with nothing sent). Counters are keyed
digests; no network or email address is stored for them.

### Sessions

A session is an opaque `aps_` token stored as a hash, with the realm's
configured lifetime. Rotation replaces the token at once without extending the
lifetime. A session is valid only while the user is active, the realm is active
and at the claims revision the session was issued under, and the environment,
project and organization are active.

### OIDC providers

A provider has a name, an `https` issuer, a client ID, scopes and optionally the
name of an environment secret that holds the client secret. The secret value is
never stored in the realm or returned by any route.

The flow is authorization code with PKCE:

1. `oidc/start` checks the redirect URI and returns the provider's authorization
   URL with a single-use `ao_` state, a nonce and an S256 challenge.
2. `oidc/complete` spends the state first, then exchanges the code and verifies
   the ID token: signature against the provider's published keys, issuer,
   audience, expiry and nonce.

Only an address the provider marks as verified is accepted. A returning provider
subject is the same user even if their address changed. A verified address links
to an existing user with that address. A new user is created only when signup is
open. Discovery must come from the configured issuer and name it back. Provider
errors are never returned to the caller.

The public configuration lists provider names only.

## Database access as an app user

`POST /assertions` exchanges a live session for a 60-second assertion addressed
to Carbon Database and bound to one request (method, path and body digest). It
needs `CARBON_APP_ASSERTIONS=enabled`. The principal is the app user, the scope
carries the realm, and the only permissions that can be named are `data.read`
and `data.write`.

Carbon Database then:

- takes the realm from the signed assertion, never from the request;
- refuses anything but row reads and writes for an app user (no schema, table
  listing or policy changes);
- asks Cloud's live authority, which re-checks the session, user, realm, claims
  revision and resource state;
- runs the query under the environment's restricted role with the verified user
  ID as the row-policy identity.

A table with an `owner` rule therefore shows each user only their own rows. A
table with policies disabled shows an app user nothing. A developer session
cannot use the application access mode, and an app user cannot use policy
preview.

## Events

Realm and user actions are written to `app_auth_events` and appear in the
organization log ([audit-events.md](audit-events.md)). An end user's own action
has a `system` actor there and names the user as the resource.

## Not included

- Passwords, phone or passkey sign-in, and MFA for app users.
- Custom claims and roles for app users; row policies see the user ID only.
- Export of users.
- Browser use from another origin: the app API sends no CORS headers, so it is
  for native apps and server-side callers.
- App users in Carbon Registry or anything other than Database row access.
- The legacy organization-wide end users of `/v1/end-users/*` are unchanged and
  are not migrated into realms.
- The OIDC client is tested against a stand-in provider, not a real one.
