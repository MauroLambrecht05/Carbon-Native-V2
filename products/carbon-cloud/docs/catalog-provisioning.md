# Canonical catalog and provisioning

The account API now composes `@carbon/catalog` against Cloud PostgreSQL. Migration
0014 adds durable operations, steps, attempts and service bindings to the canonical
catalog from 0013. API contracts are in [catalog-api.openapi.json](catalog-api.openapi.json).

All catalog writes require the account session, configured Origin, CSRF,
`Idempotency-Key`, fresh authentication and an `If-Match` revision. Project
creation uses the organization revision; environment creation uses the project
revision; resource commands use that resource's revision; operation retry/cancel
uses the operation revision. Identical retries return the original safe receipt.
Names and namespaces are bounded, and namespaces/environment names have database
uniqueness constraints. Tenant relationships use composite foreign keys.

| Endpoint | Behavior |
| --- | --- |
| `GET/POST /platform/v1/orgs/{orgId}/projects` | List assigned projects, or create a project and initial development environment. |
| `GET/POST .../projects/{projectId}` | Read a project; update its name/namespace, set production policy, archive or restore. |
| `GET/POST .../projects/{projectId}/environments` | List or create isolated canonical environment identities. |
| `GET/POST .../environments/{environmentId}` | Read lifecycle/readiness/bindings; rename, pause or resume. |
| `GET/POST .../environments/{environmentId}/operations/{operationId}` | Read durable progress; request cancellation or retry incomplete work. |

Project creation body:

```json
{"name":"My app","slug":"my-app","services":["database","registry"]}
```

The services array must contain one or both supported owners. The response is
202 with a `CatalogReceipt` and `Location` pointing to the operation. Creation
commits project/environment IDs, the creator's assignment, permission revision,
pending bindings, operation steps and an audit event together. It does not claim
that remote resources are ready. Environment creation takes `name`, `kind`
(`development`, `staging`, `production`) and `services`. Production also needs
`productionConfirmation` equal to the current project namespace.

Owner/Admin project creation is included. Developer creation needs an explicit
`projects.create` grant. The creator receives an assignment to the new project;
no unrelated project becomes accessible. Environment configuration checks
`resources.configure` at its exact scope. A prospective production environment
requires project production policy and, for Developer, an explicit project/org
configuration grant. An administrator enables the policy with
`{"kind":"production-policy","allowed":true,"confirmation":"my-app"}`.

Project commands are `update` (`name`, `slug`) and `archive` (`archived`,
`confirmation`), in addition to production policy. Archive stops new work while
preserving reads and recovery. Environment commands are `rename` (`name`) and
`pause` (`paused`, with `productionConfirmation` for production). Pausing blocks
Cloud-authorized writes immediately and queues service pause steps. Resume leaves
the environment paused until every owning service confirms activation. An
unfinished environment operation prevents another lifecycle operation from
replacing it. Cancellation is still permitted for the actor or an administrator
when a project is archived or organization suspended, provided read authority and
required MFA remain valid.

Lists use ascending IDs, bounded pages and 15-minute encrypted cursors bound to
session, permission revision, scope and page size. Parent revisions invalidate
changed pages. Detail, operation and cursor requests recheck tenant membership,
assignment and required MFA. Foreign, removed or deleted scopes return 404.

Run migrations before the API or worker, then start the separate worker:

```powershell
bun run --cwd products/carbon-cloud migrate
bun run --cwd products/carbon-cloud catalog-worker
```

The worker requires `DATABASE_URL` and `CARBON_ACCOUNT_AUTH=enabled`. Configure
`CARBON_PROVISIONING_DATABASE_ORIGIN` and/or
`CARBON_PROVISIONING_REGISTRY_ORIGIN` with pinned HTTPS origins; explicit loopback
HTTP is allowed for development. When any origin is configured, supply
`CARBON_PUBLIC_ORIGIN`, `CARBON_ASSERTION_KEY_ID`, `CARBON_ASSERTION_PRIVATE_KEY`
(Ed25519 PKCS#8 PEM), and UTC `CARBON_ASSERTION_KEY_NOT_BEFORE` /
`CARBON_ASSERTION_KEY_NOT_AFTER`. This is explicit self-hosted signing custody;
hosted KMS/HSM signing remains unfinished. Each receiver must trust the public key
and the exact issuer/audience. Keys and provider errors are not written to progress
or public error bodies. Without a configured owner adapter, its step fails with a
safe `capability` error; successful sibling steps remain stored.

Workers acquire a 45-second lease for one step and bound a service request to
20 seconds. Lease recovery records the interrupted attempt and reuses the same
step ID as the service idempotency key. Completion checks the lease, canonical
scope and existing remote binding before committing. A stale worker cannot commit
after another worker claims its lease. Current session, membership, grants,
production policy and lifecycle state are checked before every service call and
before final activation. Permission revisions are refreshed only after this live
check. Unrelated account/project progress does not grant authority or invalidate
sibling operations; resource authority revisions detect configuration changes.

Operations retain independently successful steps and bindings. Failure produces
`failed` or `partially_succeeded` and degraded environment readiness. Retry uses
current authentication and operation revision, preserves successes, and queues
only incomplete steps. If configuration changes during a service request, its
confirmed success is retained but further work/final activation requires review
and retry. Cancellation stops future steps, records in-flight success and retains
remote resources for recovery. It is not a remote rollback or deletion.

The outgoing lifecycle protocol is a signed POST to
`/internal/platform/v1/environments/{environmentId}/lifecycle`, with exact scope,
binding ID, operation ID, step ID, lease ID, action and expected remote ID. The assertion
binds audience, actor, permission, method, path and body digest. Receivers must
atomically deduplicate by step ID and reject scope/remote rebinding. Responses are
bounded, redirects rejected, and scope, binding, remote ID and desired state
validated. The contract is in
[service-lifecycle-api.openapi.json](service-lifecycle-api.openapi.json).

Database/Registry receivers now verify signatures, consume assertions durably and
check live Cloud authority before execution and again before committing native
resources. Signed status reads require current metadata access. Real HTTP tests
against three PostgreSQL databases cover native schema/role and Registry namespace
creation, pause/resume, stale leases, replay, durable retries and revocation rollback.
See [service setup and limits](service-lifecycle.md). The [native data adapter](native-data.md)
implements structured operations with PostgreSQL RLS and a signed internal data API;
browser-facing Cloud integration,
general SQL isolation, Registry publishing integration and production cutover remain unfinished.
Event publication/streams, invitation assignments, legacy adoption, deletion/retention,
commercial quotas and the production browser also remain open.
