# Owning-service lifecycle setup and evidence

Cloud now provisions canonical Database and Registry environments through real
signed HTTP receivers. The protocol covers ensure, pause, resume and metadata
status reads. It is opt-in and does not complete the general data-plane migration.
See [lifecycle OpenAPI](service-lifecycle-api.openapi.json) and
[live authority OpenAPI](authority-api.openapi.json).

## Configuration

Enable `CARBON_INTERNAL_PLATFORM=enabled` on Cloud, Database and Registry. Cloud
also requires its configured account platform. All three require the same exact
`CARBON_ASSERTION_ISSUER` as the worker's `CARBON_PUBLIC_ORIGIN`, and a JSON array
`CARBON_ASSERTION_TRUST_KEYS` containing 1–32 explicitly trusted public keys:

```json
[{"id":"deployment-key-id","publicKeyPem":"-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_ED25519_SPKI_PUBLIC_KEY\n-----END PUBLIC KEY-----","notBefore":"2026-09-12T00:00:00.000Z","notAfter":"2026-10-12T00:00:00.000Z","revoked":false}]
```

Replace the illustrative key and validity interval before enabling. Only Ed25519
SPKI public keys are accepted. IDs must be unique; malformed keys or intervals
fail startup. Receivers pin their own `carbon-database` or `carbon-registry`
audience. Rotate using overlapping validity windows and explicit revocation.
Private worker signing configuration is documented in
[catalog provisioning](catalog-provisioning.md); never put a private key in the
trust array. Hosted KMS/HSM custody remains pending.

Database and Registry additionally require `CARBON_AUTHORITY_ORIGIN`, the pinned
Cloud origin serving `/internal/platform/v1/authority`. Origins must be HTTPS;
explicit loopback HTTP is allowed for local development. Redirects are rejected.
Authority requests send the original signed proof, have a five-second deadline,
and accept only a bounded successful `{ "current": true }` response. Missing,
revoked or unavailable authority cannot authorize a request. All internal
responses use `Cache-Control: no-store` and no browser session authentication.

Keep each product's existing database and object-store configuration. Startup
runs Database's `database_schema_migrations` and Registry's
`registry_schema_migrations` ledger. They serialize migration runners, verify
checksums, adopt unchanged legacy migrations once, and apply pending migrations
transactionally. Native Database lifecycle provisioning needs an administrative
connection allowed to create roles and schemas. This connection is not a safe
customer SQL execution identity.

## Persistence and authorization

Every recipient verifies signature, exact request digest, scope, audience and
grant, consumes the assertion in its PostgreSQL replay store, and asks Cloud for
live authority. Lifecycle writes must match the current running operation, step,
lease, actor session and resource authority revisions. The receiver checks local
tenant ownership independently and checks Cloud authority again before commit.
Status reads require current `metadata.read`, matching scope and binding, but no
running operation.

The receiver commits native resources, the command receipt and its audit event
together. Step IDs identify business operations; the receipt digest excludes only
the signed lease ID so a newly authorized lease can recover a prior committed
result after response loss. Changed scope, action or binding cannot reuse that
receipt. Old leases cannot authorize a new execution.

Database creates a UUID-derived schema and a separate `NOLOGIN`, non-superuser
role without role creation, database creation, replication or RLS bypass. It
revokes public schema access and grants only schema usage, table DML and sequence
usage. Pause removes writes and retains reads; resume restores writes. Default
privileges cover subsequent objects created by the provisioning owner. These are
native PostgreSQL [role attributes](https://www.postgresql.org/docs/16/sql-createrole.html)
and [object privileges](https://www.postgresql.org/docs/16/sql-grant.html).

This verifies schema ACL boundaries, not arbitrary SQL safety. The separate
[native data adapter](native-data.md) now implements structured operations with
PostgreSQL RLS. A privileged session using `SET ROLE` is not a sandbox; general SQL
execution, signed application-user integration, function/catalog restrictions and
restricted connection identities still need implementation. Legacy SQL routes have not been migrated to
these canonical resources. Registry persists a scope-bound namespace and its
active/paused state; package publishing still needs integration with that namespace.
Legacy routes, seeded packages and legacy signing behavior remain separate work.

## Reproducible integration checks

The test service is the isolated `carbon-service-test-postgres` container using
`pgvector/pgvector:pg16`, Docker context `desktop-linux`, loopback port 55440.
The following credentials belong only to that disposable local test service:

```powershell
$env:CARBON_SERVICE_TEST_DATABASE_URL = 'postgres://carbon_test:carbon_test_local_only@127.0.0.1:55440/carbon_service_test'
bun test ./.tools/automation/testing/platform-lifecycle.integration.test.ts ./.tools/automation/testing/platform-service-migrations.integration.test.ts
```

The suite creates three randomly named databases, migrates real product schemas,
and uses real Bun HTTP servers with Ed25519 assertions. Fixtures establish the
account session; organization and catalog creation use Cloud's account API.
Tests verify native schema/role creation, foreign-schema denial, pause/resume,
Registry namespace state, durable replay, wrong audience, tampered scope, stale
leases, status-read revocation, response-loss recovery and transactional rollback
when authority changes before commit. Handler recomposition checks persisted state;
it is not an OS-process restart test. Migration tests additionally cover concurrent
adoption, preserved legacy records, checksum drift and failed-migration rollback.
Cleanup is restricted to each harness's own databases and generated native roles.

Without the explicit test URL these integration cases skip. Bazel targets are
`//.tools/automation/testing:platform_lifecycle_test` and
`//.tools/automation/testing:platform_service_migrations_test`; a passing skipped
target does not prove PostgreSQL behavior. This evidence is local integration,
not a production deployment or cutover claim.
