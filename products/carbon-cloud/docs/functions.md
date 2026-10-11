# Functions and schedules

A function is code an environment owns and Cloud runs on a worker. This
document describes what exists after Phase 13. The wire contract is in
[function-api.openapi.json](function-api.openapi.json); storage is Cloud
migration `0030_functions.sql`.

Functions run on worker leases, so they exist exactly when workers are
configured. Read [workers.md](workers.md) first: leases, attempts, heartbeats
and lease-bound secrets are used here unchanged.

**Functions are not isolated.** A function runs as a child process of the
worker, as the worker's operating-system user, with no limit on CPU, memory,
disk or network. Only wall time and output size are bounded. Do not run code
you do not trust on a worker that holds anything worth protecting (G-100).

## The model

| Thing | What it is | Can it change? |
|---|---|---|
| Function | A name in an environment, a state (`active` or `disabled`), and a pointer to its active revision | Yes, by commands |
| Revision | Code, its SHA-256, the names of the secrets it gets, and a time limit | Never. The database refuses updates and deletes |
| Execution | One run of one revision with one input | What it runs never changes; once finished, nothing does |
| Schedule | An interval on which the function is run | Yes: pause, resume, delete |

## Deploying

`POST .../environments/{id}/functions` with a name, the code, the secret names
and a time limit of 1 to 300 seconds. It needs `resources.configure`.

- The first deploy of a name creates the function with revision 1.
- Each later deploy adds the next revision and makes it the active one.
- Every secret named must exist and be enabled in the environment at that
  moment.
- The code is parsed, and refused with `400` if it is not a valid JavaScript
  module or has no default export. It is never run, imported or evaluated in
  Cloud: a module that throws when loaded deploys, and fails on the worker.

The code is one ES module of at most 262,144 characters. Its default export is
called with the input, and what it returns is the output:

```js
export default async (input) => {
  return { greeting: `hello ${input.name}`, key: process.env.API_KEY !== undefined };
};
```

`activate` moves the active pointer to any existing revision. Going back to an
earlier revision is the same command as going forward.

Reading a revision's code needs `resources.configure`, not `metadata.read`.
Listing functions, revisions and executions never returns code.

## Executions

`POST .../functions/{id}/invoke` with `{ "input": ... }` queues one execution
and answers `202` straight away. It needs `data.write`. The caller follows the
execution with `GET .../executions/{id}`.

### Revision pinning

An execution records the revision that was active when it was created, and that
is the revision it runs:

- A deploy or `activate` after the execution was queued does not change it.
- A lost worker's next attempt runs the same revision with the same input.
- A retry runs the original's revision and input, not the active revision.
- A scheduled execution takes the revision active when its slot fires.

The database enforces this: an update that changes an execution's function,
revision, code digest, input, trigger or environment is refused, and so is any
update to a finished execution.

### States

| State | Meaning |
|---|---|
| `queued` | Waiting for a worker to claim the lease |
| `running` | A worker has read the input |
| `succeeded` | The worker reported an output |
| `failed` | The function failed, no worker took it (`no_worker`), or every attempt lost its worker (`worker_lost`) |
| `timed_out` | The worker stopped it at its time limit (`function.timeout`), or Cloud's deadline passed (`deadline_exceeded`) |
| `cancelled` | Cancelled by an account, or by disabling the function (`function_disabled`) |

A failure carries a category and nothing else. Error text stays on the worker,
and there are no logs (G-102).

### Timeout and recovery

- A queued execution waits at most 10 minutes for a worker.
- When an attempt reads its input, the deadline becomes the revision's time
  limit plus 15 seconds.
- The worker kills the function at its time limit and reports
  `function.timeout`.
- If nothing is reported by the deadline, Cloud's reconciler ends the execution
  as `timed_out` and cancels the lease. A result that arrives after the deadline
  is refused, even before the reconciler has run.
- If the worker stops heartbeating, the lease sweeper grants a new lease and the
  execution runs again, up to three attempts in total. After the third loss it
  fails as `worker_lost`.

A failure the function itself reports is not retried automatically. Only a lost
worker is. This means a function can run more than once for one execution when
a worker dies part-way, so a function with side effects must tolerate that
(G-110).

### Cancel and retry

`POST .../executions/{id}` with `{ "kind": "cancel" }` or `{ "kind": "retry" }`
and the execution's revision in `If-Match`. Both need `data.write`.

- **Cancel** ends a queued or running execution and cancels its lease in the
  same transaction. The worker learns on its next heartbeat, kills the process,
  and can no longer read secrets or report.
- **Retry** is for an execution that failed, timed out or was cancelled. It
  creates a new execution with `trigger: "retry"` and `retryOf` set. The
  original is not changed.

### Disabling

`disable` cancels every queued and running execution of the function, and
refuses new invocations and retries. Schedules keep their rhythm but skip each
slot while the function is disabled. `enable` allows work again; skipped slots
are not made up.

## Secrets

A revision names the secrets it gets. When an execution is created, its lease
is granted with exactly those names, and the lease is the only way a secret
reaches a worker ([workers.md](workers.md)). The worker passes them to the
function as environment variables.

- A function cannot get a secret its revision does not name.
- Two revisions of one function can name different secrets; each execution gets
  its own revision's.
- If a named secret is missing or disabled when an execution would be created,
  nothing is created: an invocation answers `400`, and a schedule skips the
  slot.
- A revision names a secret, not a version of it. An execution gets the value
  current when the worker fetches it (G-103).
- A function may return or print a secret. The worker replaces every exact
  occurrence of one of the lease's secret values with `[redacted]` in the
  output and in the log before either leaves the machine, including where the
  value sits inside JSON text. A secret shorter than four characters, or one
  the function has encoded or split, is not recognised.

## Schedules

A schedule is one of two kinds, made with `POST .../functions/{id}/schedules`:

- `{ "intervalSeconds": N }`, from 60 seconds to 7 days. The first run is one
  interval after creation.
- `{ "cron": "30 9 * * 1-5", "timeZone": "Europe/Brussels" }`: a five-field
  cron expression read on the clocks of an IANA time zone.

Either kind takes an optional `input` of at most 65,536 bytes, which every
execution of that schedule is called with. Without one the input is null.

### Cron expressions

```
minute  hour  day-of-month  month  day-of-week
0-59    0-23  1-31          1-12   0-6 (0 is Sunday; 7 is also Sunday)
```

Each field is `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, or a
comma-separated list of those. Names (`MON`, `JAN`) and shorthands (`@daily`)
are not accepted. When both day fields are restricted, a day matches if either
does, as in cron. An expression that names a date that never occurs, such as
the 31st of February, is refused when the schedule is made, with the reason.

### Daylight saving

- A wall-clock time that does not exist on a day, because the clocks went
  forward, does not fire that day. It is not moved to the next hour.
- A wall-clock time that happens twice, because the clocks went back, fires
  once, at its first occurrence.

So `0 * * * *` in a zone with daylight saving fires 23 times on the short day
and 24 on the long one. A schedule that must run every hour of real time
should be an interval, or use `UTC`.

The zone's rules come from the runtime Cloud runs on. A zone's rules can change
by law; a schedule then follows the rules of the runtime in use.

### How schedules fire

Cloud's sweeper process fires due schedules each time it runs.

- **One execution per slot.** The schedule row is locked and re-read before
  firing, so several schedulers that see the same due slot create one
  execution. A unique constraint on schedule and slot backs this.
- **Overlap.** If the schedule's previous execution is still queued or running,
  the slot is skipped.
- **Missed slots.** If several slots passed while nothing was firing, one
  execution runs. The next slot is the next one after now: on the original
  rhythm for an interval, by the calendar for a cron expression.
- **No room.** If the environment is at its open-execution limit, the slot is
  skipped.
- **Pause and resume.** A paused schedule never fires. Resuming starts from
  now: a fresh interval, or the next calendar slot.

Every skipped slot is recorded as a `schedule.skipped.*` event with the reason,
and the schedule itself carries the last one as `lastSkippedAt` and
`lastSkipReason` (`overlap`, `function_disabled`, `limit` or `unavailable`).

## Limits

These are fixed constants, not plan quotas (G-107).

| Limit | Value |
|---|---|
| Functions per environment | 50 |
| Revisions per function | 500 |
| Schedules per function | 5 |
| Queued and running executions per environment | 20 |
| Code | 262,144 characters |
| Input | 65,536 bytes |
| Output | 262,144 bytes |
| Log per execution | 65,536 characters |
| Schedule input | 65,536 bytes |
| Time limit | 1 to 300 seconds |
| Attempts | 3 |

The open-execution limit is counted under a lock on the environment, so
callers that arrive together cannot exceed it. Exceeding a limit answers `429`.

## Idempotency

Every command takes an `Idempotency-Key`. The same key with the same request
returns the first receipt and does nothing more. The same key with a different
request answers `409`. Commands on an existing function, execution or schedule
also need its current revision in `If-Match`.

## The worker

`bun run function-worker` in `products/carbon-cloud` starts a function worker.
It needs `CARBON_CLOUD_URL` and `CARBON_WORKER_TOKEN`, from a worker enrolled
with the `function` purpose only.

For each execution the worker:

1. erases anything left from the last run, then claims a lease;
2. reads the code, input and time limit, and the lease's secrets;
3. creates a new workspace and writes the code into it;
4. starts a separate Bun process whose environment holds the secrets, the few
   variables a process needs to start, and nothing else from the worker;
5. kills the process at the time limit, or when a heartbeat says the lease is
   cancelled or lost;
6. erases the workspace, then reports the output or an error category.

The result is written to a file by a small harness, not read from standard
output, so what a function prints cannot be mistaken for its result.

## Logs

What a function writes to standard output and standard error is kept, together,
in the order the worker received it. If the function throws, or its module
fails to load, the error's stack is written there too. The worker keeps the
first 60,000 bytes, goes on reading so the function is never blocked on a full
pipe, and marks the log as truncated.

Before the log leaves the worker, every exact occurrence of one of the lease's
secret values is replaced with `[redacted]`.

`GET .../executions/{id}/logs` returns the text, whether it was truncated, and
the attempt that produced it. It needs `metadata.read`, like the execution. An
execution that printed nothing has no log and answers `404`; its `hasLogs` is
false. A log is written once and cannot be changed.

Logs arrive with the result, not while the function runs: a running execution
has none yet, and one whose worker was lost never gets one (G-102).

## Retention

Thirty days after an execution ends, its input, output and log are removed. The
execution stays, with its state, times and error category, and `prunedAt` says
when its contents were removed. This is the only change a finished execution
ever allows, and the database accepts it only in exactly that form.

The sweeper process does this each time it runs. Revisions, events and
idempotency records are not removed (G-106).

| Category | Cause |
|---|---|
| `function.invalid` | The module does not load, or has no default-exported function |
| `function.threw` | The function threw or rejected |
| `function.timeout` | It ran past its time limit |
| `function.crashed` | The process ended without a result |
| `function.output_invalid` | The return value is not JSON |
| `function.output_too_large` | The output is over the limit |
| `workspace.not_erased` | The workspace could not be removed |
| `worker.internal` | Anything else on the worker |

## Events

Function, execution and schedule changes are written to `function_events` and,
by a trigger, to `platform_events`. They are not yet in the organization audit
log (G-21).

## What is not built

Section 16 of [the backend plan](platform-backend-plan.md) asks for more than
this. See G-100 to G-113 in [the gap ledger](left-off/gaps.md). The main ones:

- No isolation or resource limits (G-100).
- Logs arrive only when an execution reports, not while it runs (G-102).
- Only an account session can invoke: no app users, service accounts, HTTP or
  event triggers (G-104).
- A schedule has no overlap or missed-run policy to choose, and no credential
  of its own (G-101).
- No drafts, packaging, dependencies or promotion between environments (G-105).
- Functions are stored in Cloud, not owned by Database as the plan says
  (G-112).
