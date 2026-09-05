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
#define CARBON_PLUGIN_ABI_VERSION_MINOR 23u

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

    /* --- ABI 1.4: global keyboard shortcuts ------------------------------
     * Registers/unregisters a system-wide keyboard accelerator (e.g.
     * "Ctrl+Alt+P") that fires even when the app is unfocused or
     * minimized — backs the `global-shortcuts` carbon-sdk plugin.
     *
     * Firing is delivered via the EXISTING push_event mechanism, as
     * `push_event("global-shortcut.fired", "{\"id\":<id>}")`. `out_id`,
     * if non-NULL, receives the SAME id that event's payload will carry
     * for this accelerator — deterministic, so re-registering the same
     * accelerator string always yields the same id, letting a caller
     * filter fired-events to just the accelerator it registered.
     *
     * Returns CARBON_OK on success, CARBON_ERR_INVALID if `accelerator`
     * doesn't parse (see products/carbon-sdk/global-shortcuts for the
     * accepted syntax), CARBON_ERR_GENERIC if the OS refused the
     * registration (e.g. already taken by another app).
     */
    int32_t (*global_shortcut_register)(CarbonApp* app, const char* accelerator, uint32_t* out_id);
    int32_t (*global_shortcut_unregister)(CarbonApp* app, const char* accelerator);

    /* --- ABI 1.5: system tray -------------------------------------------
     * Creates the app's tray icon — backs the `tray` carbon-sdk plugin.
     * One per process; a second call is a no-op (CARBON_OK, does nothing)
     * rather than an error, so a plugin's re-installed globals after HMR
     * (carbon_plugin_after_reload) can call this unconditionally.
     *
     * `icon_path` is a PNG file. `tooltip` may be empty for none.
     * `menu_items_json` is a JSON array of `{"id","label"}` objects, or
     * empty/"[]" for no context menu. Clicking the icon fires
     * push_event("tray.click", "{}"); selecting a menu item fires
     * push_event("tray.menu", "{\"id\":\"<id>\"}").
     *
     * Returns CARBON_OK on success (including the no-op second-call
     * case), CARBON_ERR_INVALID for null required arguments,
     * CARBON_ERR_GENERIC if the icon file couldn't be read/decoded as a
     * PNG or the OS refused to create the tray icon.
     */
    int32_t (*tray_setup)(CarbonApp* app, const char* icon_path, const char* tooltip, const char* menu_items_json);

    /* --- ABI 1.6: deep linking (custom URL schemes) ----------------------
     * Self-registers this app for `<scheme>://...` URLs and, if this
     * launch's argv carried one, either forwards it to an already-running
     * instance (and the calling process exits — do not assume this
     * function returns) or delivers it via
     * push_event("deeplink.url", "{\"url\":\"<scheme>://...\"}") once
     * this instance becomes the listener. Idempotent — safe to call from
     * both carbon_plugin_register and carbon_plugin_after_reload.
     *
     * macOS: NOT runtime-registerable — CFBundleURLTypes must be declared
     * in Info.plist at package time instead. Returns CARBON_ERR_GENERIC
     * there.
     *
     * Single-instance detection uses a loopback TCP listener, not a
     * platform IPC primitive with real access control — see the note on
     * this in products/carbon-sdk/deep-link's native implementation. A
     * second launch's window may flash briefly before this call detects
     * the first instance and exits — no lifecycle hook exists early
     * enough for a plugin to prevent that entirely (window creation
     * happens before any plugin loads).
     *
     * Returns CARBON_OK on success, CARBON_ERR_INVALID for a null
     * `scheme`, CARBON_ERR_GENERIC on registration failure (including
     * "not supported on this platform").
     */
    int32_t (*deeplink_register)(CarbonApp* app, const char* scheme);

    /* --- ABI 1.7: native application menu bar -----------------------------
     * Sets (or replaces) the window's native menu bar — backs the `menu`
     * carbon-sdk plugin. `menu_json` is a JSON array of top-level menus:
     *
     *   [{"label":"File","items":[
     *      {"id":"open","label":"Open"},
     *      {"separator":true},
     *      {"id":"quit","label":"Quit","accelerator":"Ctrl+Q"}
     *   ]}]
     *
     * An item is either `{"id","label"}` (`"accelerator"` optional, a
     * muda/tray-icon-style accelerator string) or `{"separator":true}`.
     * Selecting an item fires push_event("menu.click",
     * "{\"id\":\"<id>\"}"). No submenu-within-submenu nesting in this first
     * version — items are flat under each top-level menu.
     *
     * Replaces any previously-set menu (unlike tray_setup, a second call is
     * NOT a no-op) — a plugin's re-installed globals after HMR
     * (carbon_plugin_after_reload) re-applying the same menu_json is
     * therefore idempotent in effect, not just safe to call.
     *
     * Returns CARBON_OK on success, CARBON_ERR_INVALID for a null/malformed
     * `menu_json`, CARBON_ERR_GENERIC if the OS refused to attach the menu.
     */
    int32_t (*menu_setup)(CarbonApp* app, const char* menu_json);

    /* --- ABI 1.8: single-instance lock -------------------------------------
     * Acquires a process-wide named lock keyed by `app_id` (use the app's
     * own name/bundle id — the SAME value across every launch of the same
     * app, distinct across different apps).
     *
     * If another instance already holds the lock, THIS FUNCTION DOES NOT
     * RETURN — the calling process exits immediately, same "may not return
     * at all" contract as deeplink_register. Held for the entire process
     * lifetime; there is no "release" verb — the OS releases it
     * automatically on process exit, including a crash.
     *
     * Returns CARBON_OK if this is the first/only instance (the normal
     * case an app actually observes — the alternative doesn't return).
     * CARBON_ERR_INVALID for a null `app_id`. CARBON_ERR_GENERIC if the OS
     * lock primitive itself couldn't be created — best-effort: the app
     * still starts in this case rather than being blocked from launching
     * by a lock-creation failure.
     */
    int32_t (*instance_acquire)(CarbonApp* app, const char* app_id);

    /* --- ABI 1.9: embedded SQLite storage ---------------------------------
     * Opens (or reuses an already-open connection to) the SQLite database
     * at `db_path`, runs `sql` with positional parameters from
     * `params_json` (a JSON array — null/bool/number/string only; empty
     * string or "[]" for none), and returns:
     *
     *   - a SELECT: a JSON array of row objects, e.g.
     *     `[{"id":1,"name":"a"}]`.
     *   - an INSERT/UPDATE/DELETE: `{"changes":N,"lastInsertRowid":N}`.
     *
     * A blob COLUMN in a result row comes back as a base64 string; there
     * is no blob PARAM binding yet (v1 scope — see the plugin's own
     * main.zig header for why). Connections are opened lazily and kept
     * for the process lifetime, keyed by `db_path` — there is no "close"
     * verb.
     *
     * The caller owns the returned string and must free it via
     * `app->free`, same as dialog_open_file/dialog_open_files. `*out_status`
     * receives CARBON_OK, CARBON_ERR_INVALID (null/malformed arguments),
     * or CARBON_ERR_GENERIC (open failed, `sql` failed to prepare/execute,
     * or malformed params_json) — on anything but CARBON_OK the return
     * value is NULL, not a partial result.
     */
    char* (*sqlite_exec)(CarbonApp* app, const char* db_path, const char* sql, const char* params_json, int32_t* out_status);

    /* --- ABI 1.10: taskbar badge and progress (Windows only) --------------
     * `taskbar_set_progress`: sets (or clears, when `total` is 0) a
     * progress overlay on the app's taskbar button. `completed`/`total`
     * are arbitrary units — only their ratio matters.
     *
     * `taskbar_set_badge`: sets (or clears, when `icon_path` is empty) a
     * small overlay icon on the taskbar button — the closest Windows
     * equivalent to a numeric badge. `icon_path` is a PNG file, decoded
     * the same way tray_setup's `icon_path` is; the app supplies its own
     * pre-rendered badge image (e.g. a numbered circle) rather than this
     * call rendering text into one itself — v1 scope, see the taskbar
     * plugin's own main.zig for the reasoning. `description` is the
     * accessible tooltip text for the overlay (may be empty).
     *
     * Both return CARBON_OK on success, CARBON_ERR_GENERIC on any
     * platform/COM failure, and CARBON_ERR_GENERIC (not a crash) on a
     * non-Windows platform, where neither is implemented yet.
     */
    int32_t (*taskbar_set_progress)(CarbonApp* app, uint64_t completed, uint64_t total);
    int32_t (*taskbar_set_badge)(CarbonApp* app, const char* icon_path, const char* description);

    /* --- ABI 1.11: theme preferences (accent color, high contrast, ------
     * reduced motion; Windows only) --------------------------------------
     * Returns a JSON object: `{"accentColor":"#RRGGBB","highContrast":
     * bool,"reducedMotion":bool}`. Live light/dark theme changes and
     * window-focus changes are NOT part of this call — they're already
     * ambient (see the Solid renderer's onThemeChange/onWindowFocus) and
     * don't need a plugin. This is a point-in-time query, not a
     * subscription — call it again after a WM_SETTINGCHANGE-driven
     * `window.theme_changed` dispatch if you want to react live.
     *
     * The caller owns the returned string and must free it via
     * `app->free`. `*out_status` receives CARBON_OK or CARBON_ERR_GENERIC
     * (unimplemented on this platform — the return value is NULL in that
     * case, not a partial result).
     */
    char* (*theme_query)(CarbonApp* app, int32_t* out_status);

    /* --- ABI 1.12: structured file logging --------------------------------
     * Appends one JSONL line (`{"ts":"<RFC3339>","level":"<level>","msg":
     * "<message>"}`) to `path`, rotating to `<path>.1` (one backup, not a
     * numbered chain) when the file would exceed 5 MiB. `level` is a
     * free-form string (`"info"`, `"warn"`, `"error"`, ...) — not
     * validated against a fixed set. The file is opened lazily on first
     * use and kept open for the process lifetime, keyed by `path` — no
     * "close" verb.
     *
     * Returns CARBON_OK, CARBON_ERR_INVALID (null path/level/message), or
     * CARBON_ERR_GENERIC (the file couldn't be opened/written/rotated).
     */
    int32_t (*log_write)(CarbonApp* app, const char* path, const char* level, const char* message);

    /* --- ABI 1.13: screen-reader detection (Windows only) -----------------
     * `*out_active` is set to 1 if Windows reports a screen-reader-class
     * assistive technology (Narrator, JAWS, NVDA, ...) as currently
     * registered/running, 0 otherwise. Best-effort, not a guarantee
     * something is actively speaking right now — the same signal
     * browsers use for this same purpose.
     *
     * Returns CARBON_OK or CARBON_ERR_GENERIC (unimplemented on this
     * platform — `*out_active` is left at 0, not written garbage).
     */
    int32_t (*accessibility_query)(CarbonApp* app, int32_t* out_active);

    /* --- ABI 1.14: printing (Windows only) ---------------------------------
     * Sends `path` (an existing file — PDF, image, text, ...) to the
     * system print job via ShellExecute's "print" verb, using whatever
     * the OS has associated as that file type's print handler. Does NOT
     * render arbitrary content itself — the app supplies a printable
     * file, same "app supplies the asset" shape as taskbar_set_badge.
     *
     * Returns CARBON_OK, CARBON_ERR_INVALID (null path), or
     * CARBON_ERR_GENERIC (no print handler for that file type, or
     * unimplemented on this platform).
     */
    int32_t (*print_file)(CarbonApp* app, const char* path);

    /* --- ABI 1.15: screen capture (Windows only) ---------------------------
     * Captures a still image via GDI BitBlt and encodes it as a PNG at
     * `out_path`. `target` is `"screen"` (the full primary display) or
     * `"window"` (this app's own window's current client area). No
     * recording, no cross-app window targeting — captures this app's own
     * window or the whole screen, nothing else.
     *
     * Returns CARBON_OK, CARBON_ERR_INVALID (null path), or
     * CARBON_ERR_GENERIC (a GDI call failed, or unimplemented on this
     * platform).
     */
    int32_t (*screen_capture)(CarbonApp* app, const char* target, const char* out_path);

    /* --- ABI 1.16: system audio volume/mute and media-key handling ---------
     * (Windows only) ---------------------------------------------------------
     * `media_get_volume`/`media_set_volume`: the default audio-render
     * endpoint's master volume, 0.0..=1.0 (`media_set_volume` clamps).
     * `media_get_mute`/`media_set_mute`: its mute state.
     *
     * `media_listen_keys` starts (idempotently — safe to call more than
     * once) a background listener for the hardware play/pause, next,
     * previous, and stop media keys, delivered via
     * push_event("media.key", "{\"key\":\"playpause\"|\"next\"|
     * \"previous\"|\"stop\"}"). There is no "stop listening" call.
     *
     * NOT covered here: now-playing metadata in the OS media overlay
     * (needs WinRT SystemMediaTransportControls) and a hardware-
     * accelerated video decode surface (needs Media Foundation) — both
     * separate, larger pieces of work, not yet built.
     *
     * The volume getters return CARBON_OK/CARBON_ERR_GENERIC via
     * `*out_status`/`*out_muted` the way theme_query's siblings do;
     * `media_listen_keys` returns CARBON_OK once the thread is running
     * (or already was) and CARBON_ERR_GENERIC only if this platform
     * doesn't implement it at all.
     */
    int32_t (*media_get_volume)(CarbonApp* app, float* out_level);
    int32_t (*media_set_volume)(CarbonApp* app, float level);
    int32_t (*media_get_mute)(CarbonApp* app, int32_t* out_muted);
    int32_t (*media_set_mute)(CarbonApp* app, int32_t muted);
    int32_t (*media_listen_keys)(CarbonApp* app);

    /* --- ABI 1.17: input — modifier state, synthetic input, keyboard ------
     * layout (Windows only) --------------------------------------------------
     * `input_modifier_state` returns a JSON object: `{"shift":bool,
     * "ctrl":bool,"alt":bool,"capsLock":bool,"numLock":bool}` (caller
     * owns the string, frees via `app->free`; `*out_status` as usual).
     *
     * `input_send_key(vk, key_down)` sends a synthetic key press/release
     * for a Win32 virtual-key code. `input_move_mouse(x, y)` moves the
     * cursor to normalized 0..=65535 absolute screen coordinates (Win32's
     * own MOUSEEVENTF_ABSOLUTE convention — the caller maps real pixel
     * coordinates onto that range). `input_click_mouse(button, is_down)`
     * presses/releases a button (0 = left, 1 = right, 2 = middle).
     *
     * `input_keyboard_layout` returns the active layout's Windows locale
     * identifier as an 8-hex-digit string (e.g. `"00000409"` for US
     * English) — not further parsed into a BCP-47 tag, a distinct value
     * from `os.locale()`.
     *
     * NOT covered here: multi-touch trackpad gestures, Force Touch, pen/
     * stylus pressure curves, on-screen keyboard control, and keyboard-
     * layout CHANGE events (this is a point-in-time query) — each a
     * separate, materially larger piece of work, not yet built.
     */
    char* (*input_modifier_state)(CarbonApp* app, int32_t* out_status);
    int32_t (*input_send_key)(CarbonApp* app, uint16_t vk, int32_t key_down);
    int32_t (*input_move_mouse)(CarbonApp* app, int32_t x, int32_t y);
    int32_t (*input_click_mouse)(CarbonApp* app, int32_t button, int32_t is_down);
    char* (*input_keyboard_layout)(CarbonApp* app, int32_t* out_status);

    /* --- ABI 1.18: biometrics — Windows Hello user-consent verification --
     * (Windows only) ---------------------------------------------------------
     * `biometric_verify(message)` starts an OS-native Windows Hello
     * verification prompt (fingerprint / face / PIN, whatever the device
     * and user have configured) and returns immediately with CARBON_OK
     * once the request has been dispatched — `message` is empty-safe (a
     * default prompt is used) and NOT the eventual answer. It is
     * deliberately NOT synchronous: the underlying WinRT call can only be
     * awaited with a blocking, non-message-pumping wait, and this app's
     * JS/event-loop thread is a single-threaded apartment whose own async
     * completions are marshaled back through that same thread's message
     * queue — blocking it on its own pending callback is a guaranteed
     * deadlock, not a hypothetical one. The verification therefore always
     * runs on a dedicated background thread, and the outcome arrives as a
     * `biometrics.result` event: `{"verified":bool,"result":
     * "verified"|"deviceNotPresent"|"notConfigured"|"disabledByPolicy"|
     * "deviceBusy"|"retriesExhausted"|"canceled"|"error"}` — deliverable
     * the same way tray/menu/media's click/key events are, via the shared
     * `carbon.on`/`carbon.off` JS shim.
     *
     * Returns CARBON_ERR_GENERIC if this platform doesn't implement
     * biometric verification at all (dispatch failure, not a verification
     * failure — those only ever arrive via the event).
     *
     * NOT covered here: macOS Touch ID / Face ID (LAContext) and a Linux
     * equivalent, and any lower-level enrollment/management API — each a
     * separate, materially larger piece of work, not yet built.
     */
    int32_t (*biometric_verify)(CarbonApp* app, const char* message);

    /* --- ABI 1.19: sharing — the native OS share sheet (Windows only) -----
     * `share_content(title, text, url)` shows Windows' native Share flyout
     * for the app's own window and populates whatever of the three
     * (each empty-safe — pass "" for any not used) is non-empty. Unlike
     * biometric_verify, this IS synchronous and safe to call directly on
     * the JS/event-loop thread: `GetForWindow`/`ShowShareUIForWindow`
     * don't block on a WinRT async operation the way
     * RequestVerificationAsync does — they return immediately, and the
     * later `DataRequested` callback is delivered through the same
     * message pump already driving that thread's own window, the same
     * reentrancy-safe pattern taskbar_set_progress/menu_setup already
     * rely on. Returns CARBON_OK once the share flyout has been shown —
     * NOT an indication of whether the user completed or cancelled the
     * share, which this deliberately doesn't track (the OS shell handles
     * that UI itself; an app that needs a completion signal is a
     * separate, larger piece of work, not built here).
     *
     * NOT covered here: sharing files (needs a native IStorageItem
     * wrapper around an app-owned path — a separate, larger piece of
     * work), and any equivalent on macOS (NSSharingServicePicker) or
     * Linux (no OS-native equivalent exists).
     */
    int32_t (*share_content)(CarbonApp* app, const char* title, const char* text, const char* url);

    /* --- ABI 1.20: bluetooth — BLE scan, connect, notify-subscribe, ------
     * write (Windows only) -----------------------------------------------
     * `bluetooth_scan_start`/`bluetooth_scan_stop` start/stop watching for
     * BLE advertisements. Each discovered device delivers a
     * `bluetooth.device` event: `{"address":"AA:BB:CC:DD:EE:FF",
     * "name":string|null,"rssi":int}`.
     *
     * `bluetooth_connect(address)` (same colon-hex address form) connects
     * on a dedicated background thread and returns immediately once
     * DISPATCHED, not once connected — the outcome arrives as
     * `bluetooth.connected` or `bluetooth.connect_error`
     * `{"address":...,"error"?:string}`. Every call below that touches
     * GATT has this same "returns once dispatched" contract, for the same
     * reason biometric_verify does: the underlying WinRT calls can only be
     * awaited with a blocking, non-message-pumping wait.
     *
     * `bluetooth_subscribe(address, service_uuid, characteristic_uuid)`
     * (UUIDs as standard `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` strings)
     * enables GATT notifications for that characteristic on an ALREADY
     * connected device. Delivers `bluetooth.subscribed`/
     * `bluetooth.subscribe_error` once enabled, then every value-changed
     * notification after that arrives as a BINARY event (see
     * push_plugin_binary_event's own doc comment) named
     * `"bluetooth.notify." + characteristic_uuid` — raw bytes, no base64/
     * JSON. NOTE: the event name does not include the device address —
     * subscribing to the same characteristic UUID on two different
     * connected devices at once isn't distinguishable in v1, a known,
     * documented limitation.
     *
     * `bluetooth_write_characteristic(address, service_uuid,
     * characteristic_uuid, data, data_len)` writes to a characteristic;
     * delivers `bluetooth.write_result` `{"characteristicUuid":...,
     * "ok":bool}`.
     *
     * NOT covered here: a one-shot GATT read (needs a request-id
     * correlation scheme across the async boundary that notify's fire-
     * and-forget shape doesn't need — a separable, larger piece of work),
     * full service/characteristic enumeration (the app is expected to
     * already know the UUIDs it targets), pairing/bonding UI, and any
     * macOS/Linux equivalent.
     */
    int32_t (*bluetooth_scan_start)(CarbonApp* app);
    int32_t (*bluetooth_scan_stop)(CarbonApp* app);
    int32_t (*bluetooth_connect)(CarbonApp* app, const char* address);
    int32_t (*bluetooth_subscribe)(CarbonApp* app, const char* address, const char* service_uuid, const char* characteristic_uuid);
    int32_t (*bluetooth_write_characteristic)(
        CarbonApp* app,
        const char* address,
        const char* service_uuid,
        const char* characteristic_uuid,
        const uint8_t* data,
        size_t data_len
    );

    /* --- ABI 1.21: microphone — live PCM capture (Windows only) -----------
     * `microphone_start()` dispatches setup on a background thread (same
     * "can't block the JS thread on a WinRT IAsyncOperation" reason as
     * biometric_verify) and returns once DISPATCHED — the outcome arrives
     * as `microphone.started` `{"sampleRate":int,"channels":int}` or
     * `microphone.start_error` `{"error":string}`. Once started, every
     * audio quantum (device-dependent, commonly ~10ms) delivers a BINARY
     * event (see push_plugin_binary_event's own doc comment) named
     * `"microphone.frame"` — interleaved 32-bit float PCM, the format
     * WinRT's AudioGraph always normalizes to regardless of the source
     * device's native format; use the sample rate/channel count from
     * `microphone.started` to interpret it.
     *
     * `microphone_stop()` stops and releases the capture graph; safe to
     * call synchronously (unlike start, this is not a WinRT async call).
     *
     * NOT covered here: device enumeration/selection (uses the system
     * default capture device only), gain control, voice-activity
     * detection, system-audio loopback capture (the render side of
     * AudioGraph, not the capture side this uses — a separate, larger
     * piece of work), and any macOS/Linux equivalent.
     */
    int32_t (*microphone_start)(CarbonApp* app);
    int32_t (*microphone_stop)(CarbonApp* app);

    /* --- ABI 1.22: camera — live video frame capture (Windows only) -------
     * `camera_start()` dispatches setup on a background thread (same
     * "can't block the JS thread on a WinRT IAsyncOperation" reason as
     * biometric_verify) and returns once DISPATCHED. Once the first frame
     * arrives, `camera.started` fires once: `{"width":int,"height":int}`
     * (resolution isn't queried up front — reported from the first
     * decoded frame instead). Every frame after that (and the first)
     * delivers a BINARY event (see push_plugin_binary_event's own doc
     * comment) named `"camera.frame"` — raw RGBA8 bytes, `width *
     * height * 4` of them, the same byte order browser `<canvas>`
     * `ImageData`/`putImageData` already expects (no channel-swizzle
     * needed app-side even though most cameras are natively BGRA/NV12/
     * YUY2 — this call converts before delivery). A `camera.start_error`
     * `{"error":string}` event fires if no color camera is found or
     * initialization fails.
     *
     * `camera_stop()` stops and releases the capture session.
     *
     * NOT covered here: device enumeration/selection (uses the first
     * available color camera only), resolution/format negotiation
     * (accepts the device's default format, converted after the fact),
     * still-photo capture, publishing this stream as a virtual/system
     * camera source, and any macOS/Linux equivalent. No OS permission
     * model is implemented here either — a plain Win32 desktop process
     * isn't gated by the camera-privacy toggle the way a packaged app
     * is; this relies on the OS's own behavior, not a Carbon-side prompt.
     */
    int32_t (*camera_start)(CarbonApp* app);
    int32_t (*camera_stop)(CarbonApp* app);

    /* --- ABI 1.23: Carbon self-introspection (backend/runtime/manifest/ --
     * framecache/snapshot) --------------------------------------------------
     * Backs carbon-manifest, carbon-runtime, carbon-framecache, and
     * carbon-snapshot — read-only introspection of Carbon's OWN state,
     * not an OS or hosted-cloud capability. Three of these are plain
     * data fields (computed once at process startup, static for the
     * whole run — the same reasoning `app_name`/`app_version`/
     * `project_dir` above are plain fields, not trampolines):
     *
     * `backend_name` — "mini" or "blitz", which carbon-runtime binary
     * this is.
     *
     * `runtime_features_json` — a JSON object of this binary's OWN
     * compiled-in Cargo feature flags, e.g.
     * `{"network":true,"svg":true,"image":false,"audio":false,
     * "updater":false,"snapshot":true,"gpu":false,"profiling":false}`.
     * Composed by the composition root (mini.rs/blitz.rs) from its own
     * `cfg!(feature = "...")` checks — plugin-host itself has no
     * visibility into carbon-runtime's Cargo.toml and never hardcodes
     * this list, so it can't drift out of sync with the real feature set.
     *
     * `snapshot_restored` — 1 if this session's JS runtime was restored
     * from a pre-built QuickJS heap snapshot (cold-start optimization,
     * `--snapshot-build`/spike path) rather than freshly evaluating the
     * bundle from scratch, 0 otherwise. NOTE: despite the "snapshot"
     * name suggesting pixels, this is a JS-heap snapshot, unrelated to
     * screen capture — the capability catalog's original description
     * assumed the wrong mechanism; corrected here to match what
     * actually exists (`solutions/capabilities/rendering/snapshot`).
     *
     * `manifest_read(out_status)` re-parses the app's own carbon.toml
     * (fresh on every call — this is cheap, and the file can change
     * under `carbon dev`) and returns a JSON object: `{"app":{"name",
     * "version","displayName","window":{...}},"runtime":{"backend",
     * "bytecode","image","audio"},"capabilities":{"fsRead","fsWrite",
     * "netFetch","systemNotify","imageRead"},"plugins":{"<name>":
     * {"capabilities":[...]},...}}`. Deliberately does NOT include
     * `[dev-signing] trusted_keys` — a build-time trust anchor, not
     * something app code has a legitimate runtime reason to read.
     *
     * `framecache_stats(out_status)` returns
     * `{"hit":bool}` — whether THIS launch's first frame was served from
     * the on-disk warm-start cache (`dist/.carbon-frame-cache/`,
     * `products/carbon/composition/frame_cache.rs`) rather than waiting
     * for a full cold-start render. `false` on the blitz backend, which
     * doesn't use this cache at all — not a failure, just not
     * applicable.
     *
     * `framecache_clear()` deletes the on-disk warm-start cache for the
     * current project, forcing the next launch to rebuild it. Returns
     * CARBON_OK even if there was nothing to clear.
     */
    const char* backend_name;
    const char* runtime_features_json;
    int32_t     snapshot_restored;
    char* (*manifest_read)(CarbonApp* app, int32_t* out_status);
    char* (*framecache_stats)(CarbonApp* app, int32_t* out_status);
    int32_t (*framecache_clear)(CarbonApp* app);
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
