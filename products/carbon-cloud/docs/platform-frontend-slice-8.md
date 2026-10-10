# Slice 8: Registry and plugin use

Implemented against section 16 and slice 8 of section 22.2 in the
[platform plan](platform-frontend-plan.md). All package archives, signatures,
reviews, repository changes and dependency resolution remain local mock data.

## Routes and behavior

- `/registry` and `/registry/:packageId` provide visitor-safe discovery and
  package/version details. Private package existence is hidden from callers
  outside the publisher organization.
- `O/publishing`, package settings and version routes support immutable package
  identity, versioned metadata, synthetic Windows upload validation, review
  results, publication and deprecation.
- `P/plugins` and dependency detail routes show exact resolution, digest, trust,
  compatibility, capability consent, desired/proposed/synchronized state, and
  build/release impact.

The seeded SQLite entry is explicitly synthetic and cannot be downloaded as a
working DLL. Archive integrity, DLL signing and publisher trust are separate
fields. Loader-compatible local slugs remain separate from namespaced Registry
identity. Unsupported CLI syntax is labeled as proposed in the integration
recipe.

## Adapter and state

`registry-contracts.ts` defines public catalog, publishing, review and project
dependency contracts. `registry-services.ts` enforces current session,
organization membership, project assignment, permissions, revisions,
idempotency, semantic versions and exact package/version identity. Registry
state is a normalized optional collection in the existing schema-v1 workspace,
so older saved workspaces upgrade without discarding prior slice data.

Valid synthetic submissions are approved by a named fixture review; an invalid
archive fixture returns a specific traversal rejection. Publication binds the
immutable version, Windows target, digest and archive signature. Published bytes
cannot be replaced by another submission with the same semantic version.

Adding a project dependency requires explicit consent for every requested
capability. It first records a desired exact lock and a repository proposal.
Accepting that proposal records a simulated repository revision and updates the
existing delivery dependency snapshot with version, digest, trust and grants.
Future builds therefore capture the synchronized dependency in immutable build
inputs. Historical builds and releases continue to expose their original
snapshots after a desired dependency is disabled or removed.

## Verification

`tests/browser/registry.test.ts` covers public/private visibility, synthetic
review rejection, immutable publication, duplicate-version refusal, capability
consent, source synchronization and scoped authority. The presentation suite
checks that Slice 8 project routes render real workflows alongside the later
billing and operator routes.

Run the product browser typecheck/tests, mock build and asset smoke check listed
in the README. A future HTTP adapter must implement real archive validation,
durable review/trust/revocation records, publisher grants, signed metadata,
downloads and repository/CLI integration before replacing these mocks.
