# Build worker

The build worker is the process that runs a build ([builds.md](builds.md)) on an
enrolled machine ([workers.md](workers.md)). It talks to Cloud only through the
worker API and to object storage only to upload. It has no database access.

The code is in `solutions/capabilities/cloud/worker` (`RunLeasedBuildUseCase` and
its adapters). The entry point is `products/carbon-cloud/composition/build-worker.ts`.

> **Status.** The runtime is tested end to end against the real worker API with a
> real git checkout and a stand-in for the compile and package step. It has not
> yet built, packaged or signed a real Carbon app, and it does not limit CPU,
> memory, disk or network. See "Not proven" below before relying on it.

## Running it

| Setting | Purpose |
|---|---|
| `CARBON_CLOUD_URL` | Cloud's origin |
| `CARBON_WORKER_ENROLLMENT_CODE` | First start only: trades the one-time `we_` code for the credential, prints it once, and exits |
| `CARBON_WORKER_TOKEN` | The worker's `wc_` credential |
| `OBJECT_STORE_ENDPOINT`, `OBJECT_STORE_BUCKET`, `OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY` | Where artifacts are uploaded; the same bucket Cloud verifies against |
| `CARBON_WORKER_WORKSPACE` | Workspace root. Default: a directory under the system temp directory. One worker process per root |

The worker reads these and removes them from its own environment before it runs
anything. A build runs the project's scripts as child processes, and a child
inherits the environment: what is not there cannot be read.

## One build

1. **Clean first.** Everything under the workspace root is removed. If that
   fails, the worker claims nothing.
2. **Claim** a lease. No lease means idle.
3. **Heartbeat** on the interval Cloud gives. A heartbeat that reports
   cancellation, or a lease Cloud no longer honours, stops the work.
4. **Read the input** and, when the build names secrets, the lease's secrets.
5. **Create the workspace**: a directory named for the build and attempt that
   must not already exist.
6. **Check out the commit** with git into `source/`. Line endings are not
   rewritten, no credential helper is used and git never prompts. The commit git
   reports as checked out must equal the commit in the input.
7. **Require a lockfile.** `bun.lock` or `bun.lockb` must be at the project
   root. Without one, dependency ranges would be resolved at build time, so the
   build is refused before any project code runs. The digest covers the bun
   lockfile and `Cargo.lock` when present.
8. **Build** through the pipeline, which writes installers under `out/`.
9. **Upload and declare** each target: the file must be inside the workspace,
   its size and SHA-256 are taken from the bytes on disk, and it is uploaded to
   `artifacts/{buildId}/{attempt}/{target}/{file}`.
10. **Erase the workspace**, then **report success** with the materials. If the
    workspace cannot be erased the build is reported failed
    (`workspace.not_erased`), never succeeded.

On any failure the workspace is erased and the build is reported failed with a
category. After cancellation or a lost lease the workspace is erased and nothing
is reported: Cloud has already decided.

## Logs and secrets

Log text is sent in order, continuing from the sequence Cloud gives. Before it
leaves the worker, every secret value delivered with the lease, the lease token
and the worker's own credential are replaced with `[redacted]`. For a multi-line
secret each line of eight characters or more is also replaced, so a key printed
line by line is still removed. Cloud never sees the values, so it cannot do this
itself.

Secrets exist in the worker's memory and, when a build writes one to disk (a
signing certificate), under `scratch/` in the workspace. Both end with the
attempt.

## Failure categories

| Category | Meaning |
|---|---|
| `source.unavailable` | The repository could not be fetched, or git is missing |
| `source.commit_missing` | The repository does not contain the commit |
| `source.commit_mismatch` | The checked-out commit is not the requested one |
| `dependencies.unlocked` | No bun lockfile at the project root |
| `configuration.invalid` | The project's `carbon.toml` could not be read |
| `target.unsupported` | A target the platform cannot produce (Windows: `nsis`, `wix`) |
| `signing.misconfigured` | `WINDOWS_CERTIFICATE` was bound without `WINDOWS_CERTIFICATE_PASSWORD` |
| `compile.failed`, `package.failed`, `build.failed` | The pipeline failed |
| `package.missing_output`, `package.outside_workspace` | No installer for a target, or one outside the workspace |
| `artifact.upload_failed` | The upload failed |
| `completion.rejected` | Cloud refused the success, usually because a stored artifact did not match |
| `workspace.not_erased` | The workspace could not be removed |
| `worker.internal` | Anything else |

Only the category reaches Cloud. Error text stays on the worker.

## Signing

For Carbon apps the pipeline is the one `carbon build` uses locally
(`RealLocalPipeline`). When a build binds the secrets `WINDOWS_CERTIFICATE`
(a base64 PFX) and `WINDOWS_CERTIFICATE_PASSWORD`, `nsis` and `wix` outputs are
Authenticode-signed with `signtool`; the certificate is written under `scratch/`
and erased with the workspace.

## Not proven

These are in [gaps.md](left-off/gaps.md) as G-36 to G-45:

- No real Carbon app has been compiled, packaged with NSIS or WiX, or
  Authenticode-signed by this worker. The machine used for development has no
  NSIS, WiX or certificate.
- The worker does not limit CPU, memory, disk or network for a build, and does
  not run it as a separate user or in a container or VM. "Disposable" here means
  the workspace directory, not the machine.
- Compiler and installer output is not captured into the build log; only the
  worker's own stage lines are.
- Private repositories cannot be cloned: there is no clone credential.
- The worker credential is not rotated automatically.
