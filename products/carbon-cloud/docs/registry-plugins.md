# Installing packages from Registry

How a project gets packages from Carbon Registry: a declaration people write,
a lock the tool writes, and files on disk that match the lock. This document
describes what exists after Phase 15. Publishing is in
[registry-publishing.md](registry-publishing.md).

**An installed package cannot run in an app yet.** The files are verified and
written into the project, but `carbon build` does not stage them and the
runtime loader does not accept Registry's signatures (G-126). This phase built
resolution, locking, verification and installation, not loading.

## The three things

| | Path | Written by | Commit it? |
|---|---|---|---|
| Declaration | `carbon/registry.json` | People, and `add` / `remove` | Yes |
| Lock | `carbon/registry.lock.json` | The tool only | Yes |
| Installed files | `carbon/plugins/registry/<publisher>/<name>/<target>/` | `install` | No |

```json
{ "registry": "https://registry.example", "rootPublicKey": "<64 hex characters>",
  "plugins": { "acme/clipboard": "^1.2.0" } }
```

The declaration names one Registry and **the root public key this project
trusts**. Every answer from Registry is checked against that key. The key comes
from the repository, never from Registry, and no command changes it once it is
set: changing it is an edit a person makes and reviews.

The lock records, for each package, the exact version, the signed statement
that names its bytes, its manifest, and the capabilities someone approved. It
also records the highest trust-bundle sequence the project has accepted, so an
older bundle is refused from then on.

The same content always gives the same lock file, so the lock changes in
version control only when what it says changes.

## Commands

```
carbon plugin registry init --registry <url> --root-key <hex>
carbon plugin registry add <publisher/name[@range]> [--approve a,b | --approve-all]
carbon plugin registry install [--offline]
carbon plugin registry update [publisher/name] [--approve a,b | --approve-all]
carbon plugin registry remove <publisher/name>
carbon plugin registry audit
carbon plugin registry list
```

| Command | Changes the lock | Needs the network |
|---|---|---|
| `add` | Yes | Yes |
| `update` | Yes | Yes |
| `remove` | Yes | No |
| `install` | **Never** | Yes, unless `--offline` |
| `audit` | No | Yes |
| `list` | No | No |

### Ranges

A range is an exact version (`1.2.3`), `^1.2.3`, `~1.2.3` or `*`.

- `^` allows changes that keep the left-most non-zero part: `^1.2.3` admits
  `1.9.0`, `^0.2.3` admits `0.2.9` but not `0.3.0`, `^0.0.3` admits only
  `0.0.3`.
- `~` allows patch changes only.
- A pre-release is chosen only by naming it exactly. A range never moves onto
  one.
- `add` without a range picks the newest release and records `^` that version.

### What gets chosen

The newest version inside the range that:

- is built for this machine's target;
- is published, and not yanked or revoked;
- was built for the same plugin ABI major version as this toolchain, and an ABI
  minor version no newer than it.

When nothing qualifies, the message says which of those ruled everything out.

`update` applies the same rule. If the locked version has since been revoked or
yanked, `update` moves to the newest version in range that has not, which can
be an older one.

### Capabilities

A package's manifest lists the capabilities it requires and may use. `add` and
`update` stop, name them, and write nothing until each has been approved with
`--approve`.

- Only what the chosen version asks for is recorded as approved.
- A later version that asks for something new stops `update` until that is
  approved too.
- `update` with no name resolves every package before it writes anything. If
  one needs approval, none moves.

Approval is a record in the lock. Nothing at runtime yet holds a plugin to it
(G-133).

## Install

`install` makes the disk match the lock for this machine's target. It never
resolves a version and never writes the lock.

- A package the declaration names but the lock does not answer for, a changed
  range, a lock entry nobody declared, or a missing entry for this target is an
  error that says which command fixes it. `install` does not fix it quietly.
- A package already installed exactly as locked is left alone, and the network
  is not touched. "Exactly" means every file still has the digest recorded when
  it was installed.
- Directories under `carbon/plugins/registry/` that the lock does not name are
  removed.

For each package that needs installing, online:

1. The trust bundle is fetched and checked against the pinned root and the
   lock's sequence.
2. Registry is asked about the locked version. **Revoked** stops the install
   with the reason. A **different statement** for the locked version stops it
   too: a published version cannot change.
3. The archive is fetched, unless a verified copy is cached.
4. `verifyRegistryPackage` checks the signature, the package identity, the
   manifest and the bytes ([registry-publishing.md](registry-publishing.md)).
5. The archive is inspected again with the checks Registry made before
   publishing. Only files that pass are written.

Everything is verified for every package before anything is written.

### Offline

`install --offline` uses only this machine's cache
(`~/.carbon/cache/registry`, or `CARBON_REGISTRY_CACHE`), which holds archives
that passed verification and the last trust bundle that did.

- The cache is not trusted: a cached archive and a cached bundle are verified
  again, against the pinned root and the lock.
- Nothing is fetched. A missing archive or bundle is an error that says so.
- Offline, Registry cannot be asked whether a version was revoked since. Run
  `audit` when the network is back.

## Audit

`audit` asks Registry about every locked version and checks every installed
file. It changes nothing.

| Finding | Meaning | Exit |
|---|---|---|
| `yanked` | The publisher withdrew it from new installs; it still installs | 0 |
| `revoked` | An operator revoked it; the reason is shown | 1 |
| `changed` | Registry now serves a different statement for this version | 1 |
| `withdrawn` | Registry no longer lists it | 1 |
| `modified` | An installed file is not what was installed | 1 |
| `not installed` | The lock names it and the disk does not have it | 1 |

Audit does not run by itself. A revoked package that is already installed stays
installed until someone runs `audit` or installs somewhere fresh (G-134).

## Interruptions

- A command that fails before writing (the network, a trust check, an
  approval) changes nothing.
- `add` writes the declaration, then the lock, then the files. Interrupted
  after the declaration, `install` refuses and `update` finishes. Interrupted
  after the lock, `install` finishes.
- A file is written beside its destination and renamed into place.
- A package directory is built beside its destination and swapped in. If the
  swap fails, the previous directory is put back.

## What is not built

See G-126 to G-134 in [the gap ledger](left-off/gaps.md). The main ones:

- Installed packages are not built into or loaded by an app (G-126).
- Cloud has no project plugin API: no desired state in Cloud, no resolution
  from a commit, no lock written by a source proposal (G-127).
- The other CLI workflows the plan lists, and publishing from the CLI to the
  canonical Registry, are not built (G-128).
- No root key ships with the CLI; each project pins its own (G-129).
