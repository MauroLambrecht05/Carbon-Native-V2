# SDK test fixtures

Real plugin binaries staged here for the carbon-mini plugin loader (Agent 3)
to load in its integration tests. These are NOT regenerated automatically —
re-copy after rebuilding the source plugin.

## carbon_clipboard.dll (Windows)

A working build of [`plugins/clipboard`](../../../carbon-clipboard/).

- **Source**: `plugins/clipboard/`
- **Build**: `cargo build --release` from that directory
- **Copy**: `cp plugins/clipboard/target/release/carbon_clipboard.dll
  plugins/sdk/tests/fixtures/carbon_clipboard.dll`

What the loader test should verify against this fixture:

1. `LoadLibrary` (or `dlopen`) succeeds — the DLL has zero unresolved
   externals against the host (carbon-mini exports the `carbon_js_*` helpers
   at runtime; the SDK resolves them via `GetProcAddress(GetModuleHandle(NULL))`,
   so the DLL has no dynamic-link dependency on the host process).

2. `GetProcAddress("carbon_plugin_manifest")` returns a function that, when
   called, yields a NUL-terminated UTF-8 JSON string with:
   - `name == "carbon-clipboard"`
   - `abi_version_major == 1`
   - `capabilities.required == ["clipboard.read", "clipboard.write"]`
   - `modules == ["carbon:clipboard"]`

3. `GetProcAddress("carbon_plugin_register")` returns a non-null function
   pointer.

4. After `carbon_plugin_register(&app)` returns, the JS context has these
   globals installed (via `carbon_js_set_global_function` + `carbon_js_eval`
   bootstrap):
   - `__carbon_clipboard_read`        (sync, returns JSON-encoded string)
   - `__carbon_clipboard_write`       (sync, takes string arg)
   - `__carbon_clipboard_read_async`  (returns Promise<string>)
   - `__carbon_clipboard_write_async` (returns Promise<void>)

The fixture is intentionally a real working plugin (not a stub) so the
loader test exercises the full register → install-globals → run-bootstrap
path end-to-end.

## Adding fixtures for other platforms

Once the loader test runs on macOS / Linux too, build `carbon-clipboard` on
those targets and place the artifacts here:

```
fixtures/
├── carbon_clipboard.dll          (Windows x86_64)
├── libcarbon_clipboard.dylib     (macOS, universal or x86_64+aarch64)
└── libcarbon_clipboard.so        (Linux x86_64)
```

The loader test should pick the right one per `cfg!(target_os)`.
