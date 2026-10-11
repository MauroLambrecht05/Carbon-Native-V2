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
- The code is stored as given. Cloud does not run, import or check it. A syntax
  error is found the first time the revision runs.

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
- Nothing stops a function from returning a secret as its output, and the
  output is stored and readable with `metadata.read` (G-106).

## Schedules

`POST .../functions/{id}/schedules` with `{ "intervalSeconds": N }`, from 60
seconds to 7 days. The first run is one interval after creation. A scheduled
execution has a null input. There is no cron expression and no time zone
(G-101).

Cloud's sweeper process fires due schedules each time it runs.

- **One execution per slot.** The schedule row is locked and re-read before
  firing, so several schedulers that see the same due slot create one
  execution. A unique constraint on schedule and slot backs this.
- **Overlap.** If the schedule's previous execution is still queued or running,
  the slot is skipped.
- **Missed slots.** If several slots passed while nothing was firing, one
  execution runs, and the next slot is the next one after now on the original
  rhythm.
- **No room.** If the environment is at its open-execution limit, the slot is
  skipped.
- **Pause and resume.** A paused schedule never fires. Resuming starts a fresh
  interval from now.

Every skipped slot is recorded as a `schedule.skipped.*` event with the reason.

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
output, so what a function prints cannot be mistaken for its result. Standard
output and standard error are discarded.

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
- No logs (G-102).
- Only an account session can invoke: no app users, service accounts, HTTP or
  event triggers (G-104).
- Interval schedules only (G-101).
- No drafts, packaging, dependencies or promotion between environments (G-105).
- Functions are stored in Cloud, not owned by Database as the plan says
  (G-112).
