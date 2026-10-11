# Supply chain

What this repository takes from others, how that is watched, and what to do
when a check fails. The checks are the `Supply chain` workflow
(`.github/workflows/supply-chain.yml`), which runs on every push and pull
request and once a week.

## What is checked

| Check | What it does | Fails when |
|---|---|---|
| JavaScript advisories | Asks the advisory database about every package pinned in `.config/bun.lock` | A high or critical advisory has no dated exception, an exception is past its review date, or an exception matches nothing |
| Rust advisories | `cargo audit` over `.tools/orchestration/bazel/cargo/Cargo.lock` | The RustSec database lists a vulnerability for a pinned crate that is not ignored with a reason |
| Bill of materials | Writes a CycloneDX 1.5 file from the two lockfiles and attaches it to the run | A lockfile cannot be read, or one half comes out empty |
| Service images | Builds the Cloud, Database and Registry images, runs each one's migrations as a separate step, starts it told not to migrate, and waits for `/readyz` | The image does not build, the migration fails, or the service does not become ready |
| Image scan | Scans each built image | A critical or high finding has a fix available |

The bill of materials is a function of the lockfiles alone: the same commit
gives the same bytes. It lists each package's exact version, package URL and
the digest the lockfile records. It does not list the toolchains (bun, rustc,
zig) or the operating-system packages inside the images.

Moderate and low advisories are printed and do not fail. Image findings with no
fix available are listed and do not fail.

## When the JavaScript check fails

1. Read the advisory. Decide whether the vulnerable code is reachable from
   anything this repository ships or runs.
2. If a fixed version is inside the range already asked for, refresh the
   lockfile: `bun update <package>` in `.config`. For a package that is only
   there because another package needs it, a temporary `overrides` entry forces
   the lockfile forward; remove the entry afterwards and install again, so the
   manifest does not keep a rule nobody remembers the reason for.
3. If the fix needs a new major version, do that upgrade as its own change.
4. If it cannot be fixed now, write an exception in
   `.config/audit-exceptions.json`: the advisory, the package, a reason someone
   could act on, and a date to look again. An exception without a date is not
   accepted, and a date that has passed fails the check.

Run the same check locally with `bun .tools/automation/ci/audit.ts`.

## When the Rust check fails

Update the crate (`cargo update -p <crate>` in
`.tools/orchestration/bazel/cargo`). If it cannot be updated, add the advisory
to `.cargo/audit.toml` there with a comment saying why and when to look again.

## When an image check fails

A build or start failure is a defect in the Dockerfile or the service and is
fixed there. A scan failure means a package in the base image has a fix:
rebuild on a newer base, or pin the fixed package.

## Exceptions in force

`.config/audit-exceptions.json` is the list. As of 2026-10-11 it holds two, both
for `react-router` 6, both moderate, both fixed only in version 7:

- An open redirect through a backslash in a navigation target. The console
  never navigates to an address a caller supplied: a `returnTo` is checked
  against the console's own route table.
- An injection during server-side rendering hydration. Nothing here renders on
  a server.

## What this does not cover

- **Signed images and image provenance.** The images are built and scanned in
  CI and thrown away. Signing them needs somewhere to publish them, which this
  repository does not have (G-161).
- **The toolchains.** bun, the Rust toolchain and zig are pinned by version,
  not watched for advisories.
- **GitHub Actions.** The workflows use third-party actions pinned by tag, not
  by commit digest.
- **Whether a dependency is trustworthy**, as opposed to free of known
  advisories. No install script runs: `trustedDependencies` in
  `.config/package.json` is deliberately empty.
