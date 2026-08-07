# Migration baselines

What V1's runtime does, captured before anything moves, so "no functionality
loss" is a thing you can check rather than a thing you hope.

| File | Entries | What losing one costs |
|---|---|---|
| `host-functions.txt` | 139 | An app in the wild calls an undefined global. Silent until it happens. |
| `cargo-features.txt` | 9 | A bloated default binary, or a subsystem that can no longer be enabled. |
| `env-vars.txt` | 23 | The debug and test hooks. `CARBON_TEST_EXIT_MS` is how the integration tests launch an app at all. |
| `startup-phases.txt` | 27 | Startup ordering. Reorder it and every app dies on an undefined global, with no compile error. |

Regenerate and compare:

```
python .tools/validation/capture_baseline.py ../V1
python .tools/validation/capture_baseline.py ../V1 --check
```

`--check` exits non-zero on any difference. It runs against V1 today; once the
migration lands it runs against V2's own sources, and the diff is the answer to
"did we lose anything".

## Why these four and not a test suite

V1 has almost no runtime tests — one `plugin_loader_test.rs`, plus integration
tests inside `math`, `image` and `audio`. The 4,441-line `mini.rs`, the whole
host layer and the scene graph have none. So there is no suite to keep green,
and the migration has to be verified against the surface instead.

The surface is verifiable because it is mechanical: names of globals, feature
flags, env vars, phase ordering. All four are extracted from source by script,
so neither the baseline nor the check can drift from what the code says.

## What these do NOT cover

Honest gaps, so nobody mistakes a green check for proof:

- **Behaviour behind each function.** `__cm_fs_read_text` existing is not
  `__cm_fs_read_text` still reading a file. Covered by the launch test and by
  per-capability tests, not here.
- **Pixels.** Nothing here checks that the app renders correctly. `CM_SCREENSHOT`
  exists on the blitz backend and would support golden-image tests; mini has no
  equivalent yet.
- **The prop and style surface.** The scene graph accepts a large set of CSS-ish
  props, and no list of them exists. Extracting one is worth doing before the
  paint capability moves.
