# Releases and channels

A release is what installed apps are offered. It is made from a succeeded build
([builds.md](builds.md)) and never changes. A channel (`stable`, `beta`, ...) is a
pointer to a release; every time it moves, Cloud records a new signed revision.
Installed apps read a public feed and decide for themselves, using rules every
updater shares.

The wire contract is in [release-api.openapi.json](release-api.openapi.json);
storage is Cloud migration `0028_releases.sql`. Releases exist when builds do:
`CARBON_WORKERS=enabled` with the `OBJECT_STORE_*` settings, including
`OBJECT_STORE_PUBLIC_BASE_URL`.

## Signing profiles

An update is trusted because it is signed with a key the app pins in
`carbon.toml` (`[updater].pubkey`). Cloud signs with that key, held as an
environment secret ([environment-secrets.md](environment-secrets.md)).

1. Store the Ed25519 private key as a secret: the 32-byte seed in base64, or a
   PKCS#8 PEM.
2. `POST .../environments/{id}/signing-profiles` with a name and the secret's
   name. This needs `signing.manage`. Cloud reads the secret once, derives the
   public key, and records only the public key and the secret's name.

The key is decrypted inside Cloud for each signature and then dropped. It is
never returned, logged or stored outside the encrypted secret.

If the secret is later changed to a different key, Cloud refuses to sign with
that profile: the signature would not verify under the key apps pin. Put the
original key back, or create a new profile and ship an app that pins the new
key.

## Creating a release

`POST .../environments/{id}/releases` with a build, a version, notes, an optional
minimum version, a signing profile, and which of the build's artifacts to offer
under which platform key. It needs `release.publish`, CSRF and an idempotency
key.

- The build must have succeeded in the same environment. Only artifacts Cloud
  verified in storage can be offered.
- The version is [Semantic Versioning](https://semver.org) and is used once per
  environment, for good. A withdrawn version is never reissued.
- The platform key is what an installed app looks itself up by: its target
  triple, such as `x86_64-pc-windows-msvc`. One artifact per platform.
- Cloud reads each chosen artifact back from storage, checks it still matches
  the size and SHA-256 the build recorded, and signs those bytes. If an object
  changed or is gone, nothing is signed and nothing is released.

A release is immutable. A database trigger refuses any change to it other than
withdrawal, even from a direct SQL statement.

## Channels

`POST .../environments/{id}/channels/{name}` with one of:

| Command | Effect |
|---|---|
| `{"kind":"publish","releaseId":...,"rollout":N}` | The channel now offers this release to N% of installs. Creates the channel if it does not exist. |
| `{"kind":"rollout","rollout":N}` | The same release, offered to N% of installs. `0` pauses the rollout. |

Promotion is `publish` on another channel with the same release. Moving a
channel back to an earlier release is also `publish`.

Each command creates a new **revision**: a number, the release, the rollout, and
the exact manifest text with its signature. Revisions are never changed or
deleted, so a channel's whole history is on record
(`GET .../channels/{name}`). A command on an existing channel must carry the
channel revision the caller last saw (`If-Match`); a stale one is refused.

A release is not changed by being published, promoted or rolled out.

## Withdrawing a release

`POST .../releases/{id}` with `{"kind":"withdraw","reason":"..."}` and the
release's revision. In one transaction:

1. the release becomes `withdrawn` and joins the environment's stop list;
2. every channel that offers it gets a new revision pointing at the last release
   that channel offered that is still published, at the rollout it had then,
   serving the manifest that was signed for it then;
3. a channel that never offered anything else offers nothing.

Withdrawal blocks new offers. It does not recall, uninstall or restart anything.
An install already running the withdrawn version rolls back to its previous
slot the next time it reads the stop list, if it has one. A withdrawn release
cannot be offered again.

## The public feed

Each environment has a feed with an unguessable address. A channel's is returned
as `feedUrl`, and is what goes in the app's `[updater].url`:

```
GET /updates/v1/{feed}/{channel}/manifest.json   the current revision's manifest
GET /updates/v1/{feed}/{channel}/manifest.sig    Ed25519 signature over exactly those bytes, base64
GET /updates/v1/{feed}/{channel}/yanked.json     the stop list: withdrawn versions
```

The feed takes no credential and returns nothing secret. Responses may be cached
for 60 seconds. A channel that offers nothing answers 404 for the manifest and
still serves the stop list. An environment that is not active (paused, or
scheduled for deletion) answers 404 for all three.

The manifest has the same shape and byte order as the one `carbon publish`
writes, built by the same code, so an updater that accepts one accepts the
other. Artifact URLs point at `OBJECT_STORE_PUBLIC_BASE_URL`, under keys that
contain the build ID.

## What an updater does

Every updater applies the same rules in the same order. They are fixed by the
shared fixture `solutions/contracts/update/fixtures/conformance.json`, which the
TypeScript updater, the Rust runtime updater and the standalone updater all run:

1. Verify the manifest signature over the fetched bytes with the pinned key.
   Never with a key the manifest names.
2. Ignore a manifest for another channel.
3. If the running version is on the stop list, roll back.
4. Only a strictly newer version is an update. An older one is never installed.
5. A version on the stop list is not installed, even if a stale manifest offers it.
6. An install older than `min_version` does not update.
7. There must be an artifact for the install's platform.
8. The install must be in the rollout: the first four bytes of
   `SHA-256(installationId + version)`, as a big-endian number modulo 100, must
   be less than the rollout percentage.

The Rust updater in the Carbon runtime is the one packaged apps use.

## Events

`signing_profile.created`, `release.published`, `release.withdrawn`,
`channel.published`, `channel.rollout_changed` and `channel.withdrawn` appear in
the organization log ([audit-events.md](audit-events.md)).

## Not included

See [gaps.md](left-off/gaps.md), entries G-51 to G-63. In short: an artifact
larger than 512 MiB cannot be released; the stop list is not signed; a signing
key cannot be rotated; compatibility is `min_version` only; nothing schedules or
halts a rollout automatically; the CLI still publishes through the older S3
path; and no packaged app has updated itself from this feed end to end.
