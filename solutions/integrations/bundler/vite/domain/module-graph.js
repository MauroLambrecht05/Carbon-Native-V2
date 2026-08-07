// Hardcoded fallback table of `carbon:*` modules and the named exports each
// one provides. Used when no `carbon-plugin.toml` manifest can be discovered
// for a plugin. The values describe what the *user-facing* virtual module
// exports — internally each export is wired up to the runtime global the
// matching native plugin installs (see `bindings` below).
//
// Keep entries flat + JSON-serializable. The plugin name (left of the colon)
// matches the `[plugins]` key the user lists in their `carbon.toml`. Adding a
// new built-in plugin is a one-line change here until the SDK manifest takes
// over.
//
// Why this exists alongside manifest-driven mode:
//   - During the SDK transition not every plugin ships a `carbon-plugin.toml`
//     yet. A working fallback keeps the build green.
//   - For docs / IDE completion we want a single canonical list of what the
//     "blessed" `carbon:*` modules look like.

/**
 * Map of virtual module specifier → list of exports.
 *
 * Each export is one of:
 *   { name: "PublicName", global: "globalThis.AccessExpression" }
 *
 * The build-time virtual module body is just:
 *   `export const PublicName = globalThis.AccessExpression;`
 * so there is zero runtime cost beyond a property read.
 *
 * Plugin name (the part after `carbon:`) is what gets validated against the
 * project's `carbon.toml [plugins]` section. e.g. `carbon:audio` requires
 * `audio = true` in `[plugins]`.
 */
export const BUILTIN_MODULES = {
  // ── carbon-audio ───────────────────────────────────────────────────────
  // The audio plugin installs Web-Audio-shaped classes onto globalThis.
  // We re-export them under their canonical names so user code can write
  //   `import { AudioContext } from 'carbon:audio'`
  // instead of relying on the magic global. The class identities are the
  // same — we're just bridging the import system to the runtime install.
  "carbon:audio": [
    { name: "AudioContext", global: "AudioContext" },
    { name: "AudioBuffer", global: "AudioBuffer" },
    { name: "AudioBufferSourceNode", global: "AudioBufferSourceNode" },
    { name: "GainNode", global: "GainNode" },
    { name: "OscillatorNode", global: "OscillatorNode" },
    { name: "AnalyserNode", global: "AnalyserNode" },
    { name: "AudioParam", global: "AudioParam" },
    { name: "AudioDestinationNode", global: "AudioDestinationNode" },
  ],

  // ── carbon-image ───────────────────────────────────────────────────────
  // The image plugin currently registers underscore-prefixed function
  // globals (`__carbon_image_load_path`, etc) and the `CarbonImage` class.
  // The virtual module strips the underscore prefix so user-facing API
  // looks like `import { loadPath } from 'carbon:image'`. The mapping is
  // explicit — we never want to accidentally expose a different internal
  // helper to user code by tweaking the prefix scheme.
  "carbon:image": [
    { name: "loadPath", global: "__carbon_image_load_path" },
    { name: "loadBytes", global: "__carbon_image_load_bytes" },
    { name: "decodeSync", global: "__carbon_image_decode_sync" },
    { name: "CarbonImage", global: "CarbonImage" },
  ],

  // ── carbon-canvas (placeholder) ────────────────────────────────────────
  // The GPU/canvas plugin is still being defined. We list the planned
  // surface here so user code can target it; if the plugin isn't installed
  // the named export will resolve to undefined at runtime — but the
  // capability check would already have failed the build with a clear
  // error before we got here.
  "carbon:canvas": [
    { name: "createCanvas", global: "__carbon_canvas_create" },
    { name: "getDevice", global: "__carbon_canvas_get_device" },
    { name: "GPUCanvas", global: "GPUCanvas" },
  ],

  // ── carbon-clipboard ───────────────────────────────────────────────────
  // The clipboard plugin installs two underscore-prefixed sync helpers
  // (`__carbon_clipboard_read` / `__carbon_clipboard_write`) AND a pair of
  // Promise-wrapped versions that the JS-side bootstrap defines in the
  // plugin's `register` hook. We expose the async versions as the canonical
  // user surface, mirroring the Web Clipboard API:
  //
  //   import { read, write } from "carbon:clipboard";
  //   await write("hello");
  //   const text = await read();
  //
  // Both functions return Promises. `read()` resolves with a string;
  // `write(text)` resolves with `undefined`. They reject with an `Error`
  // whose `.message` describes what went wrong (empty clipboard, OS denial,
  // etc.). v1 is text-only — image / HTML clipboard support is TODO.
  "carbon:clipboard": [
    { name: "read", global: "__carbon_clipboard_read_async" },
    { name: "write", global: "__carbon_clipboard_write_async" },
  ],

  // ── carbon-fs ──────────────────────────────────────────────────────────
  "carbon:fs": [
    { name: "readFile", global: "__carbon_fs_read_file" },
    { name: "writeFile", global: "__carbon_fs_write_file" },
    { name: "readDir", global: "__carbon_fs_read_dir" },
  ],

  // ── carbon-notify ──────────────────────────────────────────────────────
  "carbon:notify": [
    { name: "notify", global: "__carbon_notify" },
  ],

  // ── carbon-tray ────────────────────────────────────────────────────────
  "carbon:tray": [
    { name: "createTray", global: "__carbon_tray_create" },
  ],
};

/** All recognized `carbon:*` specifiers (the keys of BUILTIN_MODULES). */
export const BUILTIN_SPECIFIERS = new Set(Object.keys(BUILTIN_MODULES));

/**
 * Extract the plugin name from a `carbon:*` specifier.
 *   `carbon:audio`        → `audio`
 *   `carbon:audio/extras` → `audio`   (sub-paths reserved for future use)
 *
 * Returns null for anything that doesn't begin with the carbon: prefix.
 */
export function pluginNameOf(specifier) {
  if (typeof specifier !== "string") return null;
  if (!specifier.startsWith("carbon:")) return null;
  const tail = specifier.slice("carbon:".length);
  if (!tail) return null;
  const slash = tail.indexOf("/");
  return slash === -1 ? tail : tail.slice(0, slash);
}
