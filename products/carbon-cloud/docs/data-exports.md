# Data exports

An export copies the rows of one table into a private file that its creator can
download once per link. It is a durable job: it survives restarts, resumes where
it stopped, can be cancelled, and checks the creator's access at every step.

The wire contract is in
[data-export-api.openapi.json](data-export-api.openapi.json); storage is Cloud
migration `0029_data_exports.sql`. Exports exist when the data transport is
configured (`CARBON_DATA_DATABASE_ORIGIN`) and `CARBON_DATA_EXPORTS=enabled`
with a private bucket in `CARBON_EXPORT_BUCKET`. That bucket must not be the
public artifact bucket; Cloud refuses to start if the two are the same.

## What is exported

Exactly what a row query by the same person would return. The export reads rows
through the same signed request to Database, under the same row policies, as the
account data API does ([account-data.md](account-data.md)). There is no
administrative bypass: rows the creator's access cannot see are not in the file.

A request names a table, a format, and optionally a selection (filters, columns,
selected IDs) with the same meaning as in a query. Rows are written in ID order.

| Format | Shape |
|---|---|
| `jsonl` | One JSON object per line: `{"id": ..., "values": {...}}` |
| `csv` | A header row (`_id` then the columns), CRLF line endings, RFC 4180 quoting |

Values are written exactly as the data API returns them. Integers and decimals
stay the exact strings they are on the wire, so nothing is rounded. In CSV, a
text cell that begins with `=`, `+`, `-`, `@`, tab or carriage return is written
with a leading apostrophe, so opening the file in a spreadsheet cannot run a
formula. Numbers are never altered.

## Lifecycle

All routes are `POST` under `.../environments/{id}/data/exports` and need the
session and CSRF token.

| Route | Purpose |
|---|---|
| `POST .../data/exports` | Start an export. Needs a recently authenticated session and an idempotency key equal to the command ID |
| `POST .../data/exports/list` | The latest 50 exports of the environment |
| `POST .../data/exports/{id}/status` | One export |
| `POST .../data/exports/{id}/cancel` | Cancel it |
| `POST .../data/exports/{id}/download` | Issue a download address |

States: `queued`, `running`, `ready`, `failed`, `cancelled`, `expired`.

Starting, listing and reading an export need both `data.read` and
`metadata.read`. An environment can have five exports queued or running at once.

**Running.** The export worker (`data-export-worker`) claims a job, reads up to
20 pages of 500 rows from Database, stores each page as a part in the private
bucket, records the part, and hands the job back for the next claim. A finished
export is `ready` for 24 hours.

**Authority is live.** Each claim resolves the creator's access again in Cloud:
the session the job was started from must still be valid and must still allow
reading the data. Each request to Database carries a fresh signed assertion that
Database checks against Cloud once more. If access is gone the job fails as
`access_revoked`.

**Resuming.** A part's object is written first, under a key fixed by the job and
part number, and only then recorded together with the new checkpoint. So:

- storage is unreachable: the part is not counted and the job waits and retries;
- the worker dies after writing a part but before recording it: its lease runs
  out, another worker resumes from the last recorded part and overwrites the
  same object;
- no row is exported twice and none is skipped.

**Cancelling.** The creator, or a member with `organization.manage`, can cancel.
A job no worker holds ends at once. A job a worker holds ends at that worker's
next checkpoint. Parts already stored are deleted by the sweep.

**Schema changes.** Every part of one export is read at the same table revision.
If the table's schema changes part-way the export fails as `schema_changed`
rather than mixing two shapes of row.

**Limits.** 5,000,000 rows, 2 GiB, six hours. Past any of them the export fails
(`too_large`, `deadline_exceeded`).

## Downloading

Only the person who created an export can download it, because it holds what
their access could read. `POST .../download` needs a recently authenticated
session and returns:

```json
{ "url": "https://cloud.example/platform/v1/exports/download/ex_...", "expiresAt": "..." }
```

- The address works **once** and for **60 seconds**.
- It carries no session; the token in the path is the whole credential. Only its
  hash is stored.
- When it is used, the creator's access is checked again. If it has been
  revoked, the download is refused and the address is spent.
- The file is streamed part by part from private storage. No bucket URL, public
  or presigned, is ever produced.

Unknown, used, expired and refused addresses all answer 404.

## Housekeeping

The worker's sweep marks `ready` exports past 24 hours as `expired` and deletes
the stored parts of every expired, failed or cancelled export.

## Events

`export.queued`, `export.started`, `export.ready`, `export.failed`,
`export.cancel_requested`, `export.cancelled`, `export.expired`,
`export.download_issued`, `export.downloaded` and `export.download_refused`
appear in the organization log ([audit-events.md](audit-events.md)). Events
carry no row data.

## Not included

See [gaps.md](left-off/gaps.md), entries G-64 to G-75. In short: an export ends
when its creator's session does; there is no all-rows administrative export;
rows are always in ID order; a part written but never recorded by a job that is
then cancelled is not cleaned up; and the S3 adapter has only run against a
local MinIO container.
