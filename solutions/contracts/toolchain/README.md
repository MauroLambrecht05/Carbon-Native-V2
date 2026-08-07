# toolchain

The versions this workspace is built against.

**Agreements**
- `schema/dependencies.schema.json` — the file's shape
- `types/Toolchain.ts` — its TypeScript side, plus version comparison

**Instance** `.config/dependencies.json`
**Honoured by** `MODULE.bazel` (`bazel_dep` versions),
`.tools/environments/docker/Dockerfile` (what it installs),
`.github/workflows/ci.yml` (what it provisions), and
`products/carbon-cli` (`carbon doctor` reports mismatches)

## Why this is a contract and not just a config file

Four things have to agree about, say, which Rust the project builds with, and
until now nothing compared them. They had already drifted: `flatbuffers` was
recorded as `23.5.26`, a version that has never existed on the registry — the
earliest published is `24.3.7` — while `MODULE.bazel` carried `24.3.25`,
because that is what it took to make the workspace resolve at all.

So the file that reads like the source of truth held a value that would fail if
anything used it. `.tools/validation/check_workspace.py` now compares the
`libraries` block against `MODULE.bazel` on every run.

## Blast radius

A **config break**. Changing a version does not invalidate stored data or a
wire format; it changes what CI provisions and what the container installs.
The failure mode is a build that works on one machine and not another, which
is why the checker is part of validation rather than advisory.

## Exact versions, not ranges

`^1.76` would let two machines resolve differently while both claim to be
correct. The schema rejects ranges for that reason. `carbon doctor` compares
major and minor only, since the declared patch is what CI installs rather than
a floor every developer must match.
