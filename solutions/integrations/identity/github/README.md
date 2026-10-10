# GitHub account identity adapter

Implements `ExternalAccountProvider` using GitHub's OAuth web authorization-code
flow with S256 PKCE, explicit `user:email` scope and an exact configured callback.
The flow revalidates `/user` and `/user/emails`, identifies a human user by durable
numeric ID, and returns a verified primary email plus verified aliases. It does
not return or persist provider tokens, treat a public profile email as verified,
or use GitHub's two-factor flag to bypass Carbon MFA.

GitHub documents an OAuth API identity flow here, rather than issuing an OIDC ID
token for this user sign-in exchange. Carbon must implement provider-specific
verification accordingly. Sources checked on 2026-09-12:

- [OAuth authorization and PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Authenticated user identity](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
- [Verified email addresses](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user)

Requests pin GitHub endpoints, reject redirects, use a shared 15-second deadline,
bound JSON bodies to 256 KiB and enumerate at most ten fixed email pages. Errors
exclude provider bodies, authorization codes and credentials. Exchanges are not
retried automatically because a code can already have been consumed.

This adapter alone does not issue an account session. The identity capability's
`ExternalAccountAuthentication` use case supplies durable browser-bound state,
encrypted verifier custody, consent, explicit account linking, Carbon MFA and
account/session transactions. Product composition enables its callback routes only
with explicit provider configuration. Transport tests use captured responses,
not live GitHub accounts.
