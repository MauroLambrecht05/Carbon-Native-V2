# carbon

The runtime. Two binaries — `carbon-mini` and `carbon-blitz` — that take a
project directory and run it as a desktop application.

```
composition/     how the runtime assembles itself for a given app
├── mini.rs          entry point: composes the scene-graph stack
├── blitz.rs         entry point: composes the document stack
├── manifest.rs      reading carbon.toml at startup
├── bundle.rs        loading and evaluating the app's JavaScript
├── snapshot.rs      restoring or building the QuickJS heap snapshot
└── features.rs      which optional subsystems get registered

presentation/    every surface something reaches in or out through
├── host/            the __cm_* functions an app calls
│   ├── scene.rs         the scene-graph surface     (mini)
│   ├── tree.rs          helpers over that tree      (mini)
│   ├── image.rs         async image loading         (mini)
│   ├── document.rs      the document surface        (blitz)
│   ├── dom.rs           the DOM it builds           (blitz)
│   └── css.rs           JSON props into CSS         (blitz)
├── js/              driving the engine from the event loop
│   ├── pump.rs          scene-graph model
│   └── pump_dom.rs      document model
└── timing/          the startup phase trace, which is stderr output
    ├── trace.rs         full trace with per-phase deltas   (mini)
    └── minimal.rs       one line per phase                 (blitz)

tests/           launches a real app and asserts the startup sequence
```

## Why there is no mini/ or blitz/ directory

There used to be, and it was wrong. `mini` and `blitz` are two implementations
of the same idea — turn an app's JSX into pixels — not two kinds of product.
Organising the tree by which binary a file belonged to meant every concern was
duplicated across two folders and none of them was named.

Both entry points now declare the **same module names**:

```rust
mod host;    // scene.rs      vs  document.rs
mod pump;    // pump.rs       vs  pump_dom.rs
mod trace;   // trace.rs      vs  minimal.rs
```

Identical structure, different implementations. Adding a third backend adds
files, not folders.

## What a product is

Every product has a **presentation** layer — the surfaces through which
something reaches it. For `carbon-cli` that is commands, because a developer
types them. For `carbon` it is three at once: the `__cm_*` functions an app's
JavaScript calls, the event loop the OS delivers input to, and the trace it
writes to stderr.

Beyond that a product has whatever it needs. `carbon` needs **composition**,
because standing a runtime up for a particular app is most of what it does.
`carbon-cli` needs a small one, because a CLI mostly dispatches.

What neither has is a `domain/` or an `application/`. A product composes and
presents; the logic it composes lives in `solutions/`. That rule is enforced by
`.tools/validation/check_workspace.py`.

## Which solutions it uses

| tier | used for |
|---|---|
| `contracts/runtime` | `UserEvent` and `WindowOp`, shared with the host layer |
| `contracts/app` | the carbon.toml schema, read at startup |
| `capabilities/*` (engines) | layout, painting, text, gpu-canvas, imaging, audio, snapshot, math |
| `infrastructure/os` | the 19 native host modules |
| `infrastructure/plugin-host` | loading native plugins |
| `infrastructure/platform` | per-OS shims |
| `integrations/javascript/quickjs` | the vendored rquickjs fork |

`tlog` is the one thing that stayed in the product rather than moving to a
solution: the two binaries genuinely disagree about what it does, so it is
passed into `carbon_os::register_all` as a port and each composes its own.
