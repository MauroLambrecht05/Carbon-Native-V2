# Canonical catalog

`@carbon/catalog` owns project/environment identity, lifecycle commands and durable
service provisioning. Its shared model is the platform contract. Account-facing
use cases validate sessions, CSRF and encrypted pagination cursors; PostgreSQL
adapters recheck scoped authority under organization/account locks and commit
resource changes, operation intents, revisions, receipts and audit events together.

`ProvisionEnvironment` executes one leased step through `EnvironmentProvisioner`.
`PostgresProvisioningRepository` fences stale leases, retains attempt history and
completed service bindings, and rechecks live authority before each step. The HTTP
adapter signs canonical lifecycle requests with a pinned Cloud assertion issuer.
Service origins and private signing configuration are supplied by product
composition. Missing adapters fail explicitly; this capability has no mock fallback.

The Cloud HTTP/worker composition and operational API are documented in
[catalog-provisioning.md](../../../../products/carbon-cloud/docs/catalog-provisioning.md).
Database/Registry lifecycle receivers and signed status reads use durable replay
protection, live Cloud authority checks and local ownership constraints. Real HTTP
and PostgreSQL tests cover native resource creation, pause/resume, lease recovery
and rollback. See [service setup and limits](../../../../products/carbon-cloud/docs/service-lifecycle.md)
for the remaining data-plane isolation and production deployment work.
