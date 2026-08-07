# host

The surface the host exposes: what can be called, what is emitted, and how it
crosses a process boundary.

**Agreements** `schema/api.fbs` · `schema/events.fbs` · `schema/ipc.fbs`
**Honoured by** the runtime and anything talking to it
**Breaking it** is a wire break, and `ipc` is the one place a version skew is
guaranteed rather than merely possible — the two sides are separate processes
that were not necessarily shipped together.
