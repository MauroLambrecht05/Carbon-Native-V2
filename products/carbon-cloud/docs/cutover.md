# Cutover plan

How the platform would go from what exists to serving customers, following
section 28 of [the backend plan](platform-backend-plan.md).

**No step of this has been carried out.** There is no deployment, no staging
environment and no customer (G-03). This is the plan and a statement of what
each step needs that does not exist yet.

## Where things stand

| Step of the plan | Ready? | What is missing |
|---|---|---|
| 1. Ship real services and the production console behind a flag | Partly | The flags exist. Most of the console is not connected (G-147) |
| 2. Run production adapters in staging with all walkthroughs | No | No staging; one walkthrough exists, and not in a browser (G-151) |
| 3. Import legacy organizations and projects, verify reconciliation | Partly | An owner can claim a legacy organization; there is no bulk import or report (G-162) |
| 4. Enable internal users, then a small canary set | No | No cohort mechanism (G-162) |
| 5. Compare operations, errors, billing, resource counts, audit coverage | Partly | Metrics and logs exist; nothing to compare against |
| 6. Expand cohorts on phase gates and error budgets | No | No measurements, so no budgets |
| 7. Make the production composition the default | No | The mock composition is still the default (G-153) |
| 8. Stop legacy writes, then remove deprecated routes | No | Legacy routes and tokens still work (G-118, G-128, G-145) |

## The flags that exist

Every new area is off unless its setting turns it on, so a deployment can
enable one at a time.

| Setting | Turns on |
|---|---|
| `CARBON_WORKERS=enabled` | Worker enrollment, leases, builds and functions |
| `CARBON_DATA_IMPORTS`, `CARBON_BLOBS`, `CARBON_DATA_ENGINES` | Imports; blob storage; vectors and graph |
| `CARBON_REGISTRY_PUBLISHING=enabled` | Registry publishing, in Cloud and in Registry |
| `CARBON_BILLING=enabled` | Checkout and provider events |
| `CARBON_OPERATORS=enabled` | The operator API |
| `CARBON_CONSOLE_DIR` | Serving the production console |
| `CARBON_METRICS_TOKEN` | The metrics endpoint |
| `CARBON_MIGRATE_ON_START=disabled` | Migrations as a separate release step |
| `CARBON_NEWER_SCHEMA=allowed` | An older version serving a newer schema, for a rollback |
| `CARBON_WORKER_REQUESTS_PER_MINUTE` | The request limit per worker credential; 1,200 when unset |

These are per deployment. There is no per-organization flag, so "enable for a
canary set of organizations" cannot be done yet (G-162).

## Rollback

The plan's rule: roll back by routing traffic to the previous version, keep
what was committed, never switch users to the mock and never discard newer
database state.

What supports that today:

- Migrations are additive, and each has a note on what older code does with
  the newer schema ([migrations.md](migrations.md)).
- The production console has no mock in it, so there is nothing to fall back
  to ([platform-frontend-live.md](platform-frontend-live.md)).

What works against it:

- An older version reports **not ready** against a newer schema unless it is
  started with the rollback setting ([operations.md](operations.md), "Rolling
  back after a migration"). The setting is tested with each service as a
  process. Two versions of the code talking to each other are not (G-158).
- Some migrations change behaviour for older code, not just add tables. Their
  recovery notes say so, for example: rolling back past 0031 makes deletions
  final without regard to legal holds.

## Legacy

Still running beside the canonical platform, and still writable:

- `cc_` organization tokens and `wk_` worker tokens (staged deprecation exists:
  [legacy-tokens.md](legacy-tokens.md)).
- Cloud's `/v1` routes: the legacy build queue, end-user routes and billing.
- Database's legacy engines and routes.
- Registry's legacy API and marketplace page.
- The CLI's legacy `plugin publish` and `plugin add registry:` paths.

Each is recorded where it lives (G-99, G-108, G-118, G-128, G-145). None can be
removed until the console and CLI no longer depend on it.

## Before any customer data

In order, the things this repository cannot do for itself:

1. A deployment: three services, three databases, object storage, a controlled
   ingress with TLS, and separate credentials for staging and production.
2. The outside accounts: a KMS key, a payment provider account, an identity
   provider tenant, a GitHub App, a Windows signing certificate.
3. The database suites in CI (G-50), so that a regression in authorization is
   caught by something other than a developer's machine.
4. The independent security review (G-159), and isolation for builds and
   functions (G-38, G-100).
5. Backups and a proven restore (G-135).
6. The rest of the console (G-147), in a real browser (G-151).
