# Blob storage

Blob storage keeps files for an environment: private by default, exact bytes,
versioned if you want, and reachable only through addresses that work once.

Carbon Database owns it. Cloud authorizes each command and forwards it with a
signed assertion; Database checks that assertion against Cloud again and does
the work. The wire contract is in
[blob-api.openapi.json](blob-api.openapi.json); storage is Database migration
`0008_blob_storage.sql`.

Bytes never pass through Cloud, and are never sent as base64 or JSON.

## Configuration

| Service | Setting | Purpose |
|---|---|---|
| Cloud | `CARBON_BLOBS=enabled`, `CARBON_DATA_DATABASE_ORIGIN` | Offer the account API and reach Database |
| Database | `CARBON_BLOBS=enabled` | Offer blob storage |
| Database | `CARBON_BLOB_BUCKET` | The private bucket bytes are kept in. Must not be `OBJECT_STORE_BUCKET` |
| Database | `CARBON_DATABASE_PUBLIC_ORIGIN` | This service's public origin; transfer addresses are built from it |

Database uses the `OBJECT_STORE_*` endpoint and credentials for the bucket. It
runs cleanup once a minute.

## Commands

One endpoint takes every command: `POST
/platform/v1/orgs/{org}/projects/{project}/environments/{environment}/blobs`
with the session, the CSRF token and a JSON command. A command that changes
something carries a `commandId`, sent again as the `Idempotency-Key`, and needs a
recently authenticated session.

| Command | Permission | Result |
|---|---|---|
| `bucket.create`, `bucket.update`, `bucket.delete` | `resources.configure` | Receipt |
| `buckets.list`, `bucket.get` | `metadata.read` | Buckets |
| `objects.list`, `object.versions` | `metadata.read` | Objects |
| `object.download` | `data.read` | A download address |
| `object.upload` | `data.write` | An upload address |
| `object.delete`, `object.restore` | `data.write` | Receipt |

Seeing what exists, reading bytes and writing bytes are separate permissions.

## Buckets

A bucket has a name, a visibility (`private` or `public`), a maximum object
size, an optional list of allowed content types, a versioning switch, a
retention period in days, and a quota in bytes. Every change needs the bucket's
current revision.

Deleting a bucket needs its name as confirmation. From that moment nothing in it
can be listed, read or written, unused addresses stop working, and cleanup
deletes every byte. The name can be used again immediately.

## Uploading

1. Ask for an upload with `object.upload`: the bucket, the key, and the object's
   exact **size**, **SHA-256** and **content type**.
2. Database checks the bucket's policy and quota and returns a `PUT` address.
3. `PUT` the raw bytes to that address with the same `Content-Type`.

The address works **once**, for **five minutes**, for exactly that object. What
arrives must be exactly what was authorized: the right number of bytes, the
right digest, the right type. Anything else is refused, nothing is stored, and
the address is spent. Reading stops one byte past the authorized size, so an
oversized body is never buffered.

An object key is slash-separated segments with no empty, `.` or `..` segment.

Uploading to a key that exists creates a new version (see below).

## Downloading

`object.download` returns a `GET` address that works **once**, for **60
seconds**. It serves the stored bytes with their stored content type, as an
attachment, with `nosniff` and a sandboxing content security policy, so a stored
file cannot run as a page.

A **public** bucket's current objects are also served, without an address, at:

```
GET {database origin}/storage/v1/public/{environmentId}/{bucket}/{key}
```

Visibility is read from the bucket as it is at that moment. Making a bucket
private, pausing its environment, or deleting an object stops it being served;
shared caches may hold a copy for up to 60 seconds.

## Versions and retention

Every stored version is kept as its own object, under a storage key that has
nothing to do with the object's name.

| Event | With versioning | Without |
|---|---|---|
| A key is uploaded again | The old version becomes `replaced` and stays restorable for the retention period | The old version is removed at the next cleanup |
| An object is deleted | It becomes `deleted` and stays restorable for the retention period | It is removed at the next cleanup |
| A specific version is deleted | Removed at the next cleanup, for good | The same |

`object.restore` makes a kept version current again; the version it displaces is
kept in turn. A version past its retention is gone: it cannot be downloaded or
restored.

## Quota

A bucket's quota covers every stored version, current or not, plus every upload
that has been authorized and may still arrive. Two uploads cannot both take the
last of the space. Space comes back when an authorized upload lapses or fails,
and when cleanup removes a version.

## Cleanup

Once a minute Database:

- closes upload and download addresses that were never used;
- finds uploads that began more than ten minutes ago and never finished, deletes
  whatever bytes they stored, and closes them;
- deletes versions past their retention, bytes first, and returns their space.

## Isolation

Every bucket belongs to one environment. A command for one environment cannot
see, read, change or delete another environment's bucket or objects, by ID or by
name: they are reported as not found. Two environments can use the same bucket
names and keys.

## Metering

`blob_usage` in Database records `stored` once per stored version, `egress` once
per completed download, and `removed` once per purged version. Each row names
what it was measured from, so a repeated report cannot count twice.

## Not included

See [gaps.md](left-off/gaps.md), entries G-76 to G-87. In short: app users have
no blob access; objects are limited to 256 MiB and are buffered in memory;
transfers go through Database rather than presigned object-store URLs; a
download address stays usable for its 60 seconds even if access is revoked in
that time; usage is recorded but not reported to billing; and the legacy storage
routes still exist beside this.
