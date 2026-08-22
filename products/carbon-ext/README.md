# carbon-ext

**The Carbon plugin SDK.** What an extension author compiles against, scaffolds
from, and depends on.

```bash
carbon plugin new my-plugin      # scaffolds from presentation/templates/
cd my-plugin
zig build                        # resolves this package via composition/build.zig
carbon plugin check              # manifest vs. the extension-point registry
carbon plugin install
```

## What is in here, and what is not

A product is the **surface and the structure** — everything that makes this an
SDK rather than a pile of source. The fine details are solutions.

```
carbon-ext/
├── presentation/                what an author touches
│   ├── include/carbon_plugin.h      the C ABI they compile against
│   └── templates/plugin/            what `carbon plugin new` writes
├── composition/                 what makes those pieces one package
│   ├── build.zig                    names every module and wires them together
│   └── build.zig.zon                the package an author depends on by path
└── tests/
```

What it composes, from `solutions/`:

| Piece | Where it lives | Why there |
|---|---|---|
| The SDK implementation | `solutions/capabilities/plugin/sdk/zig/src/` | `CarbonApp`, the comptime manifest builder, the extension-point helpers. Detail, not surface. |
| The extension-point registry | `solutions/contracts/plugin/registry/` | A **contract**. `products/carbon` needs it too, and a runtime cannot depend on an SDK. |
| Parsing and rendering that registry | `solutions/capabilities/plugin/registry/` | Logic, used by `carbon ext generate`. |

`composition/build.zig` is the one file that names all three and joins them.
That is what a composition root is, and it is why an SDK is shaped like every
other product here despite having no entrypoint.

## Why there is no `main.ts`

Because there are no commands. There was a version of this that had a
`main.ts`, a dispatcher and four command classes — a second CLI, for commands
that belonged in `carbon-cli`. Being about plugins was not a reason to leave.

They are `carbon ext generate | check | list | show` now:

```bash
carbon ext list                  # every extension point
carbon ext show paint.before     # one, with the Zig to implement it
carbon ext generate              # re-render the C, Rust and TS from the Zig
carbon ext check                 # fail if any has drifted
```

An SDK is still a **shipping deliverable**, which is what `products/` means, so
it lives here — it just ships as a library rather than a program.
`check_workspace.py` applies the executable-product template only to products
carrying a `package.json`, and this one has none.

## The C ABI

`presentation/include/carbon_plugin.h` is the frozen contract: the `CarbonApp`
descriptor, the JS helpers, the entry points. Beside it at build time sits
`solutions/contracts/plugin/abi/carbon_extension_points.h`, generated from the
registry — one prototype per point, so a plugin's compiler checks the signature
rather than the loader discovering a mismatch.

Breaking either is the worst break in the repository: plugins ship prebuilt, so
a layout change stops ones already on users' disks from loading. See
[`solutions/contracts/plugin/README.md`](../../solutions/contracts/plugin/README.md).
