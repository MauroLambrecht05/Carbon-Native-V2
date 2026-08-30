/* carbon_plugin.h — the Carbon plugin C ABI v1.0
 * ============================================================================
 *
 * This header is THE contract between carbon-mini (the runtime) and native
 * plugins (audio, image, GPU, …). Every Carbon plugin compiles against this
 * file — directly (Zig, C, C++) or through the language SDKs that wrap it
 * (Rust via carbon-plugin-sdk, Zig via the zig/ wrappers).
 *
 * STABILITY RULES — read before changing this file
 * ----------------------------------------------------------------------------
 *   1. CARBON_PLUGIN_ABI_VERSION_MAJOR is bumped when ANY existing function
 *      signature, struct field, or enum value is changed, removed, or
 *      reordered. Plugins compiled against a different major version MUST
 *      be rejected by the loader.
 *
 *   2. CARBON_PLUGIN_ABI_VERSION_MINOR is bumped when fields or function
 *      pointers are *appended* to the end of `CarbonApp` or new optional
 *      lifecycle hooks are added. Old plugins continue to work; new plugins
 *      can detect older runtimes and degrade gracefully via the
 *      `abi_version_minor` field on `CarbonApp`.
 *
 *   3. NEVER insert a function pointer in the middle of `CarbonApp`. Append
 *      only. The order of fields below is part of the ABI.
 *
 *   4. NEVER use C++ keywords, `inline` functions, or anything that requires
 *      a C++ compiler to parse. This header MUST compile under a strict
 *      C99 compiler (gcc -std=c99 -Wpedantic).
 *
 * ============================================================================
 */
#ifndef CARBON_PLUGIN_H
#define CARBON_PLUGIN_H

#include <stddef.h>  /* size_t */
#include <stdint.h>  /* uint32_t, int32_t, uint8_t */

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 * ABI version
 * --------------------------------------------------------------------------
 * Plugins compare these against the runtime's reported major/minor on entry.
 * Mismatched MAJOR ⇒ refuse to register. Mismatched MINOR (older runtime)
 * ⇒ register but skip features the runtime doesn't advertise.
 */
#define CARBON_PLUGIN_ABI_VERSION_MAJOR 1u
#define CARBON_PLUGIN_ABI_VERSION_MINOR 3u

/* --------------------------------------------------------------------------
 * Status codes returned by host-provided helpers
 * -------------------------------------------------------------------------- */
#define CARBON_OK             0
#define CARBON_ERR_GENERIC   -1
#define CARBON_ERR_INVALID   -2  /* bad arguments */
#define CARBON_ERR_QUEUE_FULL -3 /* push_event ring buffer overflow */
#define CARBON_ERR_NO_CTX    -4  /* JS context unavailable (during shutdown) */
#define CARBON_NOT_FOUND     -5  /* e.g. keychain_get: no entry for (service,
                                   * account) — a real, expected outcome, not
                                   * a failure. Distinct from CARBON_OK so a
                                   * NULL return can mean either "not found"
                                   * or "found but empty" without ambiguity. */

/* --------------------------------------------------------------------------
 * Opaque types
 * --------------------------------------------------------------------------
 * Plugins NEVER dereference these. They are passed back to the function
 * pointers below. Internally, CarbonJSContext currently wraps an rquickjs
 * `JSContext*`, but plugins must not assume that — the type may change to
 * PrimJS or another engine later without an ABI bump (the carbon_js_*
 * helpers are the stable entry points).
 */
typedef struct CarbonApp        CarbonApp;
typedef struct CarbonJSContext  CarbonJSContext;

/* Callback type for carbon_js_set_global_function / CarbonApp::set_global_function.
 * Declared here (ahead of `struct CarbonApp`, which references it as of ABI
 * 1.1) rather than down with the other carbon_js_* declarations, because C
 * typedefs must precede their use. */
typedef void (*CarbonJSCallback)(CarbonJSContext* ctx,
                                 const char*      args_json,
                                 char*            result_buf,
                                 size_t           result_buf_len);

/* --------------------------------------------------------------------------
 * CarbonApp — the host descriptor passed to every plugin entry point.
 * --------------------------------------------------------------------------
 * Stable C layout. Carbon-mini fills this in before calling
 * `carbon_plugin_register` and updates the dynamic fields (window_width,
 * window_height) before each paint hook. The function pointers near the end
 * are also stable; new hooks must be APPENDED, never inserted.
 */
struct CarbonApp {
    /* --- Versioning ------------------------------------------------------
     * abi_version_major / abi_version_minor: filled in by carbon-mini with
     * the version of this header it was built with. Plugins compare against
     * their compiled-in CARBON_PLUGIN_ABI_VERSION_MAJOR/MINOR and refuse to
     * register on a major mismatch.
     */
    uint32_t abi_version_major;
    uint32_t abi_version_minor;

    /* --- JS context -----------------------------------------------------
     * Pointer to the current QuickJS-shaped JS context. Plugins use this
     * with the carbon_js_* helpers below to install globals / classes /
     * functions. May be NULL during shutdown — always null-check.
     */
    CarbonJSContext* js_ctx;

    /* --- Window state (updated by carbon-mini before paint hooks) -------
     * Logical pixels (DPI-independent). For the raw_*_handle fields, see
     * the raw_window_handle crate's HasDisplayHandle / HasWindowHandle —
     * GPU plugins (wgpu, etc.) cast and consume these via raw_window_handle.
     * On platforms where a handle is not available, the pointer is NULL.
     */
    uint32_t window_width;
    uint32_t window_height;
    void*    raw_window_handle;
    void*    raw_display_handle;

    /* --- App identity (read-only; valid for the lifetime of the plugin) -
     * `app_name` and `app_version` come from carbon.toml [app].
     * `project_dir` is the absolute, canonicalized path to the user's app.
     * `window_id` is reserved for future multi-window support — always 0
     * in v1.0.
     */
    const char* app_name;
    const char* app_version;
    const char* project_dir;
    uint32_t    window_id;

    /* --- Function pointers — host capabilities -------------------------- */

    /* push_event:
     * Push an event from any thread → carbon-mini's event loop → JS handler
     * registered as `globalThis.__carbon_on_event(name, payload_str)`.
     *
     * `event_name`   UTF-8, dot-separated like "audio.analyserData".
     *                Copied internally; the caller may free immediately.
     * `json_payload` UTF-8 JSON string (or empty string for "no payload").
     *                Copied internally.
     *
     * Returns CARBON_OK on success, CARBON_ERR_QUEUE_FULL if the event
     * queue is saturated, CARBON_ERR_INVALID for null arguments.
     */
    int32_t (*push_event)(CarbonApp* app,
                          const char* event_name,
                          const char* json_payload);

    /* request_paint:
     * Schedule a redraw of carbon-mini's window. Idempotent within a single
     * frame — multiple calls coalesce. Safe from any thread.
     */
    void (*request_paint)(CarbonApp* app);

    /* alloc / free:
     * Cross-DLL-safe allocator. Plugins MUST use these for buffers handed
     * back to carbon-mini (or vice versa). On Windows in particular, freeing
     * a CRT allocation from a different DLL's CRT is undefined.
     *
     * Currently maps to malloc / free in carbon-mini. Plugins do not need
     * to use these for their own internal buffers — only for cross-boundary
     * ownership transfers.
     */
    void* (*alloc)(size_t size);
    void  (*free)(void* ptr);

    /* --- APPEND-ONLY ZONE -----------------------------------------------
     * New function pointers / fields go BELOW this comment. Inserting them
     * above breaks every previously-compiled plugin's struct layout.
     * When you append a field, bump CARBON_PLUGIN_ABI_VERSION_MINOR.
     */

    /* set_global_string / set_global_number / set_global_function / eval:
     * ABI 1.1. Same operations as the carbon_js_* free functions below,
     * reached as function pointers on the struct the host already handed
     * the plugin instead of a runtime symbol lookup.
     *
     * WHY THIS EXISTS ALONGSIDE THE carbon_js_* FUNCTIONS: those are resolved
     * via GetProcAddress(GetModuleHandle(NULL)) / dlsym(RTLD_DEFAULT) — see
     * the RESOLUTION MODEL note below. A plugin trust checker that reads a
     * compiled artifact's import table (solutions/capabilities/plugin/trust)
     * has to deny GetProcAddress/GetModuleHandle* from every module,
     * unconditionally: a plugin that can resolve one arbitrary OS symbol at
     * runtime can resolve any of them, and a static import-table check has
     * nothing left to say once that door is open. That denial is correct and
     * plugin authors should keep relying on it — which means the ONE
     * resolution every real plugin needs (carbon_js_*, to install JS globals)
     * can no longer go through that door either.
     *
     * These four fields are the fix: the same values, handed over as
     * ordinary struct fields the host fills in — exactly how push_event and
     * request_paint already work, for the same reason. A plugin using only
     * these four, push_event, request_paint, alloc and free needs no dynamic
     * symbol resolution of ANY kind, and its import table shows it.
     *
     * A plugin built against ABI 1.0 (before these fields existed) still
     * works: it used the runtime-resolution carbon_js_* path, which is
     * untouched below. New SDKs should prefer these fields; the free
     * functions stay for that reason and for non-C SDKs that have not moved
     * yet.
     */
    int32_t (*set_global_string)(CarbonJSContext* ctx,
                                 const char*      name,
                                 const char*      value);
    int32_t (*set_global_number)(CarbonJSContext* ctx,
                                 const char*      name,
                                 double           value);
    int32_t (*set_global_function)(CarbonJSContext* ctx,
                                   const char*      name,
                                   CarbonJSCallback fn);
    int32_t (*eval)(CarbonJSContext* ctx, const char* source);

    /* load_font_path / load_font_bytes:
     * ABI 1.2. Load a TTF/OTF font into the runtime's text engine,
     * optionally registered under `family_name` so CSS/JSX
     * `font-family: "<family_name>"` selects this exact face afterward
     * (see solutions/capabilities/rendering/text/lib.rs's
     * `font_for_char_named`) instead of only being picked by glyph
     * coverage. Pass NULL for `family_name` to load anonymously (the
     * face still joins the coverage-fallback stack, just not selectable
     * by name).
     *
     * `weight` is the CSS font-weight scale (1-1000; 400 = Regular, 700 =
     * Bold). Pass 0 to default to 400. Loading the SAME family_name
     * multiple times at different weights (e.g. "Poppins" at 400 and
     * again at 700) registers real weight variants — `font-bold` text in
     * that family then selects the true bold face instead of silently
     * falling back to a different family's matching weight.
     *
     * This is the ABI the fonts plugin (products/carbon-sdk/fonts) builds
     * its `loadFont(path, family, weight)` JS hook on top of — a plugin
     * author calls THIS from inside their own `set_global_function`
     * callback, synchronously, on the JS thread (the only thread a
     * JS-invoked callback ever runs on), so the return value here is
     * real, not a "queued, ask later" placeholder like `push_event`.
     *
     * Triggers a repaint + layout invalidation on success — text using a
     * newly-registered family re-measures and re-renders on the next
     * frame with no other action needed from the plugin.
     *
     * Returns CARBON_OK on success, CARBON_ERR_GENERIC if the file
     * couldn't be read / parsed as a font, CARBON_ERR_INVALID for null
     * required arguments.
     */
    int32_t (*load_font_path)(CarbonApp*  app,
                              const char* path,
                              const char* family_name,
                              uint32_t    weight);
    int32_t (*load_font_bytes)(CarbonApp*    app,
                               const uint8_t* bytes,
                               size_t         len,
                               const char*    family_name,
                               uint32_t       weight);

    /* --- ABI 1.3: clipboard / dialog / notification / keychain ----------
     * These back the `clipboard`, `dialog`, `notification` and `keychain`
     * carbon-sdk plugins — moved out of the runtime's always-on ambient
     * globals so each is an explicit, opt-in capability like fonts.
     *
     * STRING-RETURNING CALLS share one ownership shape: the return value,
     * if non-NULL, is a NUL-terminated UTF-8 string allocated via
     * `app->alloc` — the CALLER (the plugin) must free it with `app->free`
     * once done. `out_status`, if non-NULL, is written with:
     *   CARBON_OK        call succeeded. The return value is authoritative
     *                    AS-IS — NULL here means "no clipboard content" /
     *                    "user cancelled the dialog", not a failure.
     *   CARBON_NOT_FOUND keychain_get only: no entry for (service,account).
     *   CARBON_ERR_GENERIC / CARBON_ERR_INVALID: a real failure. Return
     *                    value is always NULL.
     */

    char* (*clipboard_read_text)(CarbonApp* app, int32_t* out_status);
    int32_t (*clipboard_write_text)(CarbonApp* app, const char* text);
    int32_t (*clipboard_clear)(CarbonApp* app);

    /* `opts_json` is `{"title"?, "defaultPath"?, "filters"?: [{"name",
     * "extensions":[...]}]}` — same shape across every dialog_* call. */
    char* (*dialog_open_file)(CarbonApp* app, const char* opts_json, int32_t* out_status);
    char* (*dialog_open_files)(CarbonApp* app, const char* opts_json, int32_t* out_status); /* JSON string array, "[]" if cancelled */
    char* (*dialog_open_dir)(CarbonApp* app, const char* opts_json, int32_t* out_status);
    char* (*dialog_save_file)(CarbonApp* app, const char* opts_json, int32_t* out_status);
    /* Shows the picker and returns the chosen file's CONTENT, not its path
     * — and save_file_text writes content to wherever the user chose. The
     * only way to read/write a file the user picked from outside the app's
     * own sandboxed directories without a raw filesystem path ever
     * reaching JS. */
    char* (*dialog_open_file_text)(CarbonApp* app, const char* opts_json, int32_t* out_status);
    int32_t (*dialog_save_file_text)(CarbonApp* app, const char* opts_json, const char* content); /* 1=written, 0=cancelled, <0=error */
    int32_t (*dialog_message)(CarbonApp* app, const char* title, const char* body, const char* level); /* level: "info"|"warning"|"error" */
    int32_t (*dialog_confirm)(CarbonApp* app, const char* title, const char* body); /* 1=yes, 0=no, <0=error */

    int32_t (*notification_send)(CarbonApp* app, const char* title, const char* body, const char* icon_path);

    int32_t (*keychain_set)(CarbonApp* app, const char* service, const char* account, const char* password);
    char* (*keychain_get)(CarbonApp* app, const char* service, const char* account, int32_t* out_status); /* out_status: CARBON_OK (found) | CARBON_NOT_FOUND | CARBON_ERR_GENERIC */
    int32_t (*keychain_delete)(CarbonApp* app, const char* service, const char* account);
};

/* --------------------------------------------------------------------------
 * Plugin entry points
 * --------------------------------------------------------------------------
 * Plugins implement these functions and EXPORT them by name. Carbon-mini
 * resolves them via dlsym/GetProcAddress after loading the .so/.dll.
 *
 * The only REQUIRED exports are `carbon_plugin_register` and
 * `carbon_plugin_manifest`. The rest are looked up with dlsym; missing
 * symbols are silently skipped.
 */

/* REQUIRED. Called once after carbon-mini has loaded the plugin and
 * verified its manifest against the app's [plugins] grants. The plugin
 * should install JS globals/classes, spawn background threads, etc.
 *
 * Must not block. If a plugin needs to do heavy initialization (cpal
 * device open, wgpu adapter selection), do it lazily on first JS call.
 */
void carbon_plugin_register(CarbonApp* app);

/* REQUIRED. Returns the plugin manifest as a NUL-terminated UTF-8 JSON
 * string. The pointer must remain valid for the lifetime of the plugin
 * (typically a `static const char*`). Carbon-mini parses this BEFORE
 * calling register, and refuses to load if capability requirements aren't
 * granted in the host app's carbon.toml [plugins] section.
 *
 * Schema (see README.md for examples):
 *   {
 *     "name":              "carbon-audio",
 *     "version":           "0.1.0",
 *     "abi_version_major": 1,
 *     "abi_version_minor": 0,
 *     "capabilities": {
 *       "required": ["audio.output"],
 *       "optional": ["audio.input"]
 *     },
 *     "modules":         ["carbon:audio"],
 *     "lifecycle_hooks": ["register", "before_reload", "after_reload"]
 *   }
 */
const char* carbon_plugin_manifest(void);

/* OPTIONAL. Called immediately before HMR re-evaluates the JS bundle.
 * The plugin should pause background threads and drop references to any
 * JS-owned values (the JS context survives, but globals/classes installed
 * via carbon_plugin_register will be replaced after re-eval).
 */
void carbon_plugin_before_reload(CarbonApp* app);

/* OPTIONAL. Called after the new JS bundle has finished evaluating. The
 * plugin's previous globals are gone — re-install them here, mirroring
 * what `carbon_plugin_register` did. Background threads may resume.
 */
void carbon_plugin_after_reload(CarbonApp* app);

/* OPTIONAL. Called once per frame, BEFORE the rasterizer commits the
 * pixmap to softbuffer. Plugins can read or write pixels here (e.g.,
 * a GPU-canvas plugin reads its offscreen render target and blits it
 * into the pixmap region for its <canvas> node).
 *
 * Pixel format: RGBA8, row-major, top-left origin, premultiplied alpha.
 * `stride_bytes` is normally `width * 4` but plugins MUST honor it (some
 * platforms align rows).
 */
void carbon_plugin_before_paint(CarbonApp* app,
                                uint8_t*   pixmap_data,
                                uint32_t   width,
                                uint32_t   height,
                                uint32_t   stride_bytes);

/* OPTIONAL. Called after present. Useful for FPS counters, GPU-stats
 * uploads, etc. The pixmap is no longer accessible at this point.
 */
void carbon_plugin_after_paint(CarbonApp* app);

/* OPTIONAL. Called when the carbon-mini window is resized. The
 * `app->window_width` / `app->window_height` fields are also updated to
 * the new size before this hook is invoked — the explicit args are a
 * convenience.
 */
void carbon_plugin_on_resize(CarbonApp* app,
                             uint32_t   new_width,
                             uint32_t   new_height);

/* OPTIONAL. Called once when carbon-mini is exiting. The plugin should
 * join background threads and flush any external state (database,
 * audio device, etc.). After this returns, the plugin DLL is unloaded
 * and `register` will not be called again on this process.
 */
void carbon_plugin_on_shutdown(CarbonApp* app);

/* --------------------------------------------------------------------------
 * JS context helpers
 * --------------------------------------------------------------------------
 * Plugins cannot link directly against rquickjs (or any future engine) —
 * that's a Rust-private detail of the runtime. These thin wrappers expose
 * the minimum surface needed to install JS-visible state.
 *
 * Higher-level Rust plugins typically use the carbon-plugin-sdk rust crate
 * (`packages/carbon-sdk/rust/`) which wraps these in safe types. Zig
 * plugins use `packages/carbon-sdk/zig/`. Pure-C plugins call these
 * directly.
 *
 * RESOLUTION MODEL: these symbols are EXPORTED by the carbon-mini host
 * executable. Plugins resolve them at runtime via the OS's host-process
 * symbol-lookup APIs:
 *
 *   - Windows: GetProcAddress(GetModuleHandle(NULL), "carbon_js_…")
 *   - macOS / Linux: dlsym(RTLD_DEFAULT, "carbon_js_…")
 *
 * This avoids requiring a Windows .lib import library to ship alongside the
 * SDK and keeps plugins linkable in isolation.
 *
 * AS OF ABI 1.1, `struct CarbonApp` ALSO carries these four as function
 * pointers (`set_global_string`, `set_global_number`, `set_global_function`,
 * `eval`) — see the APPEND-ONLY ZONE above. Prefer those: GetProcAddress and
 * GetModuleHandle* are exactly the loophole a static import-table check
 * cannot see through (solutions/capabilities/plugin/trust denies them from
 * every module, unconditionally, for that reason), so a plugin resolving
 * carbon_js_* this way cannot be told apart, from its import table alone,
 * from one resolving something else entirely. The struct fields carry the
 * same four operations without that ambiguity. These free functions remain
 * for plugins built against ABI 1.0 and for non-C SDKs that have not moved
 * to the struct fields yet.
 */

/* Return the current JS context. May return NULL during shutdown. */
CarbonJSContext* carbon_js_get_context(CarbonApp* app);

/* Install a string-valued global on `globalThis`.
 * `value` is UTF-8 NUL-terminated, copied. Returns CARBON_OK on success. */
int32_t carbon_js_set_global_string(CarbonJSContext* ctx,
                                    const char*      name,
                                    const char*      value);

/* Install a numeric (double) global. */
int32_t carbon_js_set_global_number(CarbonJSContext* ctx,
                                    const char*      name,
                                    double           value);

/* Install a function global. The callback receives an args JSON string
 * (a JSON-encoded array of the arguments) and writes a JSON result into
 * `result_buf` (capacity `result_buf_len`). If the result would exceed
 * the buffer, the wrapper writes "null" and signals CARBON_ERR_GENERIC
 * to the caller in JS as an exception.
 *
 * This is intentionally minimal — most plugins will use the higher-level
 * Rust/Zig SDKs which can register typed classes and methods.
 *
 * `CarbonJSCallback` itself is declared up with the opaque types, ahead of
 * `struct CarbonApp`, which references it from ABI 1.1 onward.
 */
int32_t carbon_js_set_global_function(CarbonJSContext* ctx,
                                      const char*      name,
                                      CarbonJSCallback fn);

/* Eval a snippet of JS in the host context. Returns CARBON_OK on success,
 * CARBON_ERR_GENERIC on JS exception (the exception is logged to stderr
 * by the runtime). Plugins should prefer setting globals over calling
 * eval; this is provided for bootstrap snippets only.
 */
int32_t carbon_js_eval(CarbonJSContext* ctx, const char* source);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CARBON_PLUGIN_H */
