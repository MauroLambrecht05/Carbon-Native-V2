# carbon-launcher

A native fast path for `carbon run`/`carbon dev`. Not a CLI rewrite — every
other `carbon` subcommand (scaffold, plugin, publish, build, …) stays exactly
as it is today, in TypeScript.

## Why this exists

Bun's own interpreter boot costs ~130-280ms on every `carbon run`/`carbon dev`
invocation, paid before any instrumented JS code even starts running —
invisible to every internal timing measurement because it happens before the
code those measurements cover. This binary reimplements exactly the hot-path
logic those two commands need (cache-key checks, the plugin-build cache,
spawning the runtime) natively, so launching it costs a few ms instead.

```
composition/
├── main.rs    argv dispatch (run/dev/daemon/ensure-daemon) + the fast path:
│              check node_modules/runtime/plugin-build/bundle cache state,
│              spawn the runtime directly if everything's current
├── daemon.rs  the pre-spawned carbon-mini process pool (Windows only) —
│              accepts a project handoff over a named pipe instead of paying
│              OS process-creation cost per launch
├── pipe.rs    CreateNamedPipeW with an explicit per-user+SYSTEM security
│              descriptor (Windows only)
└── spawn.rs   the plain, non-pooled process spawn every platform falls back to
```

Reusable cache logic lives in `solutions/capabilities/tooling/build-cache`
and `solutions/capabilities/plugin/build-cache` (native ports of
`BuildCache.ts`/`PluginBuildCache.ts`, kept in step so the native launcher and
the TypeScript CLI agree on cache hit/miss for identical project state) —
this crate's own code stays a thin composition layer, the same pattern
`products/carbon` (carbon-mini) already follows.

## Where it fits

`carbon run`/`carbon dev` (`products/carbon-cli`) try the daemon first via
`DaemonClient`/`tryDaemonRun` and fall straight through to a direct spawn on
any failure (unreachable, pool empty, stale) — a pure optimization, never a
dependency of either command actually working. `--pool-wait <handoff_file>`
in `products/carbon/composition/cli.rs` is the receiving half.

## What's not built

macOS/Linux daemon support (`daemon.rs`/`pipe.rs` are Windows-only; every
other platform always takes the plain `spawn.rs` path — still faster than
Bun's own boot, just without the pre-warmed pool). No graceful Ctrl-C for a
daemon-served window — it isn't attached to the CLI's own console.
