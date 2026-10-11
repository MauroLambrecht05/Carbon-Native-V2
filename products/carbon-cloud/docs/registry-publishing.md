# Registry publishing and trust

How a package gets into Carbon Registry, who vouches for it, and what an
installer checks before trusting it. This document describes what exists after
Phase 14. The wire contract is in
[registry-publishing-api.openapi.json](registry-publishing-api.openapi.json);
storage is Registry migration `0004_publishing.sql`.

Registry owns all of it: publishers, versions, archives, reviews and signing.
Cloud authorizes the account and forwards one signed command at a time, as it
does for Database ([signed-data.md](signed-data.md)).

Installing is in [registry-plugins.md](registry-plugins.md). An installed
package cannot run in an app yet (G-126).

## The path of a version

```
claim a publisher name ──► submit a version ──► upload the archive ──► operator review ──► published
                               (reserved)          (quarantined)         approve / reject      │
                                                                                               ├─► yanked / restored (publisher)
                                                                                               └─► revoked (operator)
```

| State | Meaning | Who can see it |
|---|---|---|
| `awaiting_upload` | Reserved; the bytes have not arrived | The publisher's organization |
| `submitted` | Bytes inspected and held in quarantine, waiting for review | The organization and operators |
| `rejected` | Refused at upload, rejected in review, withdrawn, or never uploaded | The organization |
| `published` | Approved and signed | Everyone |
| `revoked` | Published once, then revoked for security | Everyone, without the bytes |

## Publishers

A publisher is a name such as `acme`. Packages are `acme/clipboard`.

- `publisher.claim` gives the name to the organization that owns the
  environment the command came from. It needs `resources.configure`.
- A name is unique across Registry. A taken name answers the same to everyone.
- Names that read as the platform itself (`carbon`, `official`, `registry` and
  others) cannot be claimed.
- An organization can hold 5 publishers.
- Every environment of the owning organization can use the publisher. No other
  organization can submit under it or read its unpublished versions; to them it
  does not exist.

## Submitting

`version.submit` needs `release.publish` and declares everything up front: the
publisher, package name, version, target, the archive's exact size and SHA-256,
and a manifest (ABI version, description, required and optional capabilities).

Registry reserves the version and answers with one upload address:

```json
{ "commandId": "...", "version": { "id": "...", "state": "awaiting_upload" },
  "upload": { "method": "PUT", "url": "https://registry.example/registry/v1/uploads/ru_...", "expiresAt": "..." } }
```

- The address is a credential. It is shown once: repeating the command returns
  the version without it. Registry stores only its hash.
- It expires after 15 minutes. An unused reservation frees the version number
  the next time someone submits it.
- A version number for a target can be live only once. A rejected submission
  frees it; a published or revoked version never does.
- A publisher can have 20 versions waiting for upload or review.
- A version is a plain semantic version without build metadata.

## Uploading

`PUT` the archive bytes to the upload address. No other credential is involved,
and the bytes go to Registry directly, not through Cloud.

- Exactly the declared bytes are accepted: the size and SHA-256 must match. A
  wrong upload is refused and the reservation stays usable.
- A correct upload is inspected before anything is stored. If inspection fails,
  the version is `rejected` with the reason, nothing is kept, and no reviewer
  sees it.
- If inspection passes, the bytes go into quarantine and the version is
  `submitted`. The address stops working.

### What an archive must be

One zstd frame around a ustar tarball, at most 64 MiB.

| Check | Refused as |
|---|---|
| Not zstd, or more than one frame, or bytes after the frame | `archive.not_zstd`, `archive.trailing_data` |
| Expands to more than 200 times its size, or more than 256 MiB | `archive.expands_too_much` |
| Anything but plain files and directories: links, devices, extension records | `archive.entry_type` |
| A path that is absolute, contains `..`, a backslash, a drive letter or a reserved device name, or ends in a dot or space | `archive.path` |
| Two paths that differ only by case, or a file used as a directory | `archive.duplicate_path` |
| No `carbon-plugin.json` at the root, or one that differs from what was declared | `archive.manifest_missing`, `archive.manifest_mismatch` |
| No library named for the package (`name.dll`, `libname.so`, `libname.dylib`), or one built for another target | `archive.library_missing`, `archive.library_target` |
| Any other executable or script | `archive.unexpected_executable` |

`packArchive` builds an archive that passes, and the same files always give the
same tarball.

The library check reads the file header only. It does not prove the library
loads, exports the plugin ABI, or needs only the capabilities it declares
(G-117).

## Review

An operator decides on each submitted version. Review is a tool that runs
beside the service, not a route:

```
bun run review pending
bun run review approve <versionId> --operator <name> --reason <text>
bun run review reject  <versionId> --operator <name> --reason <text>
bun run review revoke  <versionId> --operator <name> --reason <text>
bun run review history <versionId>
```

- A decision needs an operator name and a reason. Each is recorded with the
  evidence (digest, size, file list, signing key) in a table that cannot be
  updated or deleted.
- An operator acts only on a version a publisher submitted. There is no way to
  create or change a version from here, so an operator cannot publish as a
  customer.
- **Approve** reads the quarantined bytes, checks they are still exactly what
  was submitted, inspects them again, copies them to their published place,
  and signs the statement.
- **Reject** closes the version with the reason, which the publisher can read,
  and removes the quarantined bytes.

The operator is a name typed on the command line. There are no operator
accounts and no second approver yet (G-114).

## Trust

### The statement

When a version is published, Registry signs one statement with Ed25519:

```json
{ "publisher": "acme", "name": "clipboard", "version": "1.2.0", "target": "x86_64-pc-windows-msvc",
  "sha256": "...", "sizeBytes": 20480, "manifestDigest": "...", "publishedAt": "2026-10-11T08:00:00Z" }
```

The signature covers the package, version and target as well as the bytes, so a
real signature cannot be served for a different package or an older version.

### The trust bundle

Registry's signing keys are listed in a trust bundle:

```json
{ "bundle": { "sequence": 3, "issuedAt": "...", "keys": [
    { "id": "registry-2026", "publicKey": "...", "state": "active" },
    { "id": "registry-2025", "publicKey": "...", "state": "retiring" } ] },
  "signature": "..." }
```

- The bundle is signed by a **root key that Registry never holds**. It is made
  offline with `signTrustBundle` and given to Registry as configuration.
- `active` keys sign new versions. `retiring` keys sign nothing new, but what
  they signed stays good. A `revoked` key vouches for nothing.
- `sequence` only goes up. An installer remembers the highest it has accepted
  and refuses an older bundle, which could bring a revoked key back.

### Start-up

Publishing is off unless `CARBON_REGISTRY_PUBLISHING=enabled`. When it is on,
Registry refuses to start unless:

- the bundle is signed by the configured root public key, and
- the bundle lists Registry's own signing key, by name and public key, as
  `active`.

There is no generated or fallback key on this path.

| Setting | Meaning |
|---|---|
| `CARBON_REGISTRY_PUBLIC_ORIGIN` | Where uploaders and installers reach Registry |
| `CARBON_REGISTRY_ROOT_PUBLIC_KEY` | The root public key, 64 hex characters |
| `CARBON_REGISTRY_TRUST_BUNDLE` | The signed bundle, as JSON |
| `CARBON_REGISTRY_SIGNING_KEY_ID` | The name of this Registry's signing key in the bundle |
| `CARBON_REGISTRY_SIGNING_SEED` | The signing key's seed, 64 hex characters |

Cloud needs `CARBON_REGISTRY_PUBLISHING=enabled` and `CARBON_REGISTRY_ORIGIN`.

The signing key is a seed in the environment, not a key in a KMS or HSM, and
key rotation has never been exercised in a deployment (G-115).

## Distribution

Anyone can read these without a credential:

| Request | Answer |
|---|---|
| `GET /registry/v1/trust` | The signed trust bundle |
| `GET /registry/v1/packages/{publisher}/{name}` | Every published and revoked version, with its signed statement and manifest |
| `GET /registry/v1/packages/{publisher}/{name}/{version}/{target}` | The archive of one published version |

Before sending an archive, Registry checks the stored bytes against the signed
digest. Bytes that no longer match are never sent.

### What an installer checks

`verifyRegistryPackage` does all of it. An installer must not trust any answer
because Registry gave it.

1. The bundle is signed by the root key **the installer was built or configured
   with**, and is not older than one it has seen.
2. The version is `published`, not `revoked`.
3. The statement's key is in the bundle and is not revoked.
4. The signature over the statement is valid.
5. The statement is for exactly the publisher, name, version and target that
   were asked for.
6. The manifest matches the statement's manifest digest.
7. The bytes have the statement's size and SHA-256.

Each failure has a stable category (`bundle_signature`, `bundle_rollback`,
`key_unknown`, `key_revoked`, `signature`, `wrong_package`, `manifest`,
`digest`, `revoked`).

## Yanking and revocation

| | Yank | Revoke |
|---|---|---|
| Who | The publisher (`version.yank`, `release.publish`) | An operator |
| Why | The version should not be picked for new installs | The version is unsafe |
| Listing | Stays, marked `yanked` with the reason | Stays, as `revoked` with the reason and its statement |
| Download | Still served by exact version | Never served again |
| Reversible | Yes | No |
| Version number | Stays taken | Stays taken for good |

A revoked version stays in the listing so that an installer that already has it
can learn it was revoked. Its statement, signature and review history are kept.

A publisher can also `version.withdraw` a version that has not been reviewed.

## What the database enforces

- A version's package, number, target, size, digest and manifest never change.
- States only move forward: `awaiting_upload` to `submitted` or `rejected`,
  `submitted` to `published` or `rejected`, `published` to `revoked`.
- A published version's statement, signature and stored archive never change.
- A rejected or revoked version never changes at all, and no version is ever
  deleted.
- Review records cannot be updated or deleted.

## What is not built

See G-114 to G-125 in [the gap ledger](left-off/gaps.md). The main ones:

- An installed package cannot run in an app yet, and the legacy Registry API
  still exists beside this (G-126, G-118).
- Operators are names, not accounts (G-114).
- Keys are not in a KMS, and rotation is unproven (G-115).
- Every published package is public, and any member with `release.publish`
  can publish under any of the organization's publishers (G-119).
- The binary is not checked beyond its header (G-117).
