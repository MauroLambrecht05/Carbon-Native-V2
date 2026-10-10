# Slice 10: Consistency pass

Implemented against slice 10 of section 22.2 in the
[platform plan](platform-frontend-plan.md).

The billing and operator adapters use the existing browser contract rules:
opaque IDs, decimal strings at boundaries, expected revisions, idempotency
keys, structured errors, scoped pagination, safe audit metadata and normalized
IndexedDB state. The optional Slice 9 state is additive for existing schema-v1
workspaces and all mutations survive reload.

Every route in slices 1–9 now resolves to a local workflow or an explicit
resource error. Direct operator job/organization routes do not depend on prior
navigation. Session expiry, identity switching and membership revocation reuse
the existing cache cancellation and visibility-key behavior. Billing hard caps,
project archive, organization deletion scheduling and operator suspension feed
the same authorization checks used by builds and resource commands.

The browser entry still composes only mock adapters. Its CSP uses
`connect-src 'none'`; the asset smoke check verifies that deep links, entry
module and stylesheet are local and that the hot-reload client is absent. There
is no HTTP-to-mock fallback and no Cloud, Database, Registry, repository,
payment, email, worker or native-runtime request.

Verification is the complete browser contract/presentation suite, TypeScript
typecheck, production mock build and local asset/CSP smoke check documented in
the README.
