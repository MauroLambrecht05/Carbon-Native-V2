# Realtime, vectors and graph

Three more kinds of data in an environment, all owned by Carbon Database and
reached through Cloud with signed, request-bound assertions that Database checks
against Cloud again. The wire contract is in
[data-engines.openapi.json](data-engines.openapi.json); storage is Database
migrations `0009_data_changes.sql` and `0010_vector_graph.sql`.

## Realtime: the change feed

Every canonical table has a change feed. It tells a reader *that* a row changed;
the reader then reads the row with a normal query, under their own policy.

### Capture

A trigger on each native table writes one event in the **same transaction** as
the change. It records the row, the operation, the row's new revision, and who
could see the row at that moment under the table's policies.

Because capture is in the database, it covers every way a row can change: the
data API, an import, and SQL run by an operator. A change that rolls back leaves
no event. The role that changes rows can neither read nor write the feed.

Tables that existed before this migration are captured from the migration
onward; nothing earlier is in the feed.

### Reading

`rows.changes` is a command in the data protocol, like `rows.query`, and needs
`data.read`:

```json
{ "kind": "rows.changes", "tableId": "...", "access": { "mode": "application" }, "cursor": "3.812.40", "limit": 100 }
```

- **No cursor** returns no events and a cursor for "now". A reader loads the
  table, then follows from there.
- **Order** is commit order. Only changes older than the oldest transaction
  still running are returned, so an event can never appear behind a cursor that
  was already handed out.
- **Each event** carries the operation, the row ID, the row's revision (null for
  a delete), a timestamp, and the cursor that continues after it. Reading again
  from a cursor never repeats an event.
- **Row policy per event.** A reader is told about a change only if they could
  see the row when it changed: the table has a public-read rule, or they owned
  the row. When a row changes owner, both the old and the new owner are told.
  With policies off, nobody is told anything.
- **The cursor moves past changes the reader cannot see**, so nothing about them
  can be inferred from repeated reads.
- **`reset: true`** means the cursor cannot be continued: the table's schema or
  policies changed (who may see what is part of the table's revision), or the
  cursor is older than the feed's retention. The reader loads the table again
  and continues from the cursor returned. Nothing is silently skipped.

The feed keeps **three days** of events; Database removes older ones hourly.

App users read the feed with their own request-bound assertion, as they read
rows. An account reads it as a policy preview for a chosen user.

### The stream

For the browser, Cloud turns the feed into server-sent events:

```
GET /platform/v1/orgs/{org}/projects/{project}/environments/{environment}/data/changes?tableId=...&userId=...
```

Frames are `connected` (with events, possibly none), `heartbeat`, `reset`,
`authorization_revoked` and `closed`. Every frame's `id` is the cursor to resume
from; a reconnecting `EventSource` sends it back as `Last-Event-ID` and receives
exactly what it missed, once, in order. A cursor can also be given as `cursor=`.

Each poll resolves the caller's access again and sends a fresh signed request,
so when access ends the stream says `authorization_revoked` and stops. A stream
closes itself after fifteen minutes; the client reconnects with its cursor.

## Vectors

`POST .../environments/{id}/vectors` takes one command.

| Command | Permission |
|---|---|
| `collection.create`, `collection.delete` | `resources.configure` |
| `collections.list` | `metadata.read` |
| `points.upsert`, `points.delete` | `data.write` |
| `points.get`, `points.query` | `data.read` |

A collection has a name, a **dimension** (1 to 2000) and a **metric** (`cosine`,
`l2` or `inner`). Every vector stored in or searched against it must have exactly
that dimension. A cosine collection refuses the zero vector, which has no
direction.

A point is an ID, a vector and up to 16 scalar metadata values. Upserting an
existing ID replaces it. A batch is at most 100 points.

**Scoring.** `points.query` returns `distance`, where lower is always closer:
cosine distance, Euclidean distance, or the negative inner product. Equal
distances are ordered by point ID. Search is exact, not approximate, so the same
query on the same data always returns the same answer. A `filter` of metadata
values narrows the candidates before ranking.

Vectors are stored in single precision.

**Limits.** 50 collections per environment and 100,000 points per collection.
Replacing existing points is always allowed, even in a full collection.

## Graph

`POST .../environments/{id}/graph` takes one command. Each environment has one
property graph.

| Command | Permission |
|---|---|
| `node.put`, `node.delete`, `edge.put`, `edge.delete` | `data.write` |
| `node.get`, `neighbors`, `traverse`, `path` | `data.read` |

- **Referential rules.** Both ends of an edge must be existing nodes of the same
  environment; the database enforces this, so an edge cannot dangle whatever
  writes it. An edge keeps its ends for life. A node with edges is deleted only
  with `detach: true`, which removes its edges with it.
- **Bounded walks.** `traverse` is breadth-first from a node, to a depth of at
  most 6 and at most 1,000 nodes, and reports `truncated` when the size limit cut
  it short. Each node is reached once, at its smallest depth.
- **Shortest path.** `path` returns a shortest path within the depth limit as
  nodes and edges, or `found: false`.
- **Direction and label.** Walks follow edges `out`, `in` or `both`, optionally
  only those with one label.
- **Repeatable.** Where several answers are equally good, the choice is fixed by
  ID order, so the same request returns the same result.

Walks run in the database one level at a time. A graph is never loaded into
memory.

**Limits.** 100,000 nodes and 500,000 edges per environment.

## Common rules

- A command that changes something carries a `commandId`, sent as the
  `Idempotency-Key`. Sending it again returns the same receipt and changes
  nothing; the same ID with a different body is refused.
- Every command is for one exact environment. Another environment's
  collections, points, nodes and edges are reported as not found, and it may use
  the same names and IDs.
- Authority is checked when a command arrives and again before its result
  leaves; a caller who loses access mid-command changes nothing.
- A paused environment can be read, not written.
- Vector and graph commands are for accounts and service accounts. App users
  cannot use them yet.

## Not included

See [gaps.md](left-off/gaps.md), entries G-88 to G-99. In short: change events
carry no row values; the stream is polled, not pushed, and exists only for
account sessions; vector search is exact and has no index; large vector and
graph work does not run as cancellable jobs; app users cannot use vectors or the
graph; and the legacy realtime, vector and graph engines still exist beside
these.
