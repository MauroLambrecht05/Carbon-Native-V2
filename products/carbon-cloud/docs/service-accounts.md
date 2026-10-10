# Service accounts and credentials

Managed service accounts are non-human automation principals bound to one exact
project or environment scope. Their account and credential routes are documented
in [service-account-api.openapi.json](service-account-api.openapi.json).

Creation requires a fresh browser session, CSRF, `resources.configure`, every
delegated permission, an idempotency key and the current project or environment
revision. Names are unique within the organization. Updating permissions,
disabling or enabling increments the service account permission revision and
invalidates all previously issued credentials. An enabled account needs a newly
rotated credential before it can authenticate again.

Each service account can own multiple named credentials. Create and rotate return
a random `cs_` token once. Carbon stores its SHA-256 hash, short display prefix,
expiry and audit metadata. Exact issue retries cannot recover plaintext. Rotation
can retain only the immediately previous token for at most 24 hours and never
beyond its original expiry. Revocation removes every overlap and rejects the token
on the next verification.

The live verifier requires the `automation` audience, exact scope and permission,
an active managed service account, matching service-account permission revision,
an active unexpired credential, and active organization/project/environment
parents. Successful use updates metadata-only `lastUsedAt`.

Migration 0005 contained unfinished organization-wide service-account and broad
credential tables. Migration 0020 marks those rows as legacy and does not infer a
canonical scope or import their grants. Only explicitly managed 0020 accounts are
listed or accepted. The `cc_` migration path in
[legacy-tokens.md](legacy-tokens.md) retires legacy tokens in favor of managed
service accounts; it does not convert those skeletal 0005 rows.

When `CARBON_SERVICE_ACCOUNT_ASSERTIONS=enabled`, `POST
/platform/v1/service-assertions` accepts a `Bearer cs_...` credential and an exact
Database environment, permission, method, path and body digest. Cloud returns a
60-second Ed25519 assertion containing a `service_account`/`automation` principal
and one exact grant. The receiving Database verifier binds all request fields and
calls Cloud's live authority endpoint, which checks the managed account,
credential, permission revision, resource state and Database binding again.
Rotation overlap does not widen the assertion; disabling or revoking authority
makes the live check fail immediately.

Registry uses a separate exchange, `POST /platform/v1/service-registry-assertions`,
with the `ServiceAccountRegistryAssertionExchange` contract: the
`carbon-registry` audience and a canonical `/registry/` POST path only. The
Database exchange cannot name the Registry audience. It can still sign a
Database-audience assertion for any internal path, but Registry's verifier
refuses that audience and Cloud's live authority refuses the mismatch. Live
authority for a Registry assertion checks the managed account, credential,
permission revision, resource state and the exact Registry binding.

This slice establishes the service-account principal, credentials and narrow
Database and Registry assertion exchanges. Row-policy semantics for automated
data access, direct CLI consumption, personal accounts and worker credentials
remain later BE-05/BE-06/BE-12 work.
