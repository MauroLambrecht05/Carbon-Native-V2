/*
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: solutions/contracts/plugin/registry/extension-points.zig
 * Regenerate:      carbon ext generate
 * Verified by:     .tools/validation/check_extension_points.py
 *
 * The extension points a Carbon plugin may implement.
 *
 * Every point is OPTIONAL. The host resolves each by symbol name at load
 * time and skips the ones a plugin does not export, which is what makes
 * appending a point a MINOR ABI bump rather than a break.
 *
 * Include carbon_plugin.h first — every prototype below takes CarbonApp*.
 */
#ifndef CARBON_EXTENSION_POINTS_H
#define CARBON_EXTENSION_POINTS_H

#include <stddef.h>
#include <stdint.h>
#include "carbon_plugin.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The ABI minor implied by this registry. */
#define CARBON_EXTENSION_POINTS_MINOR 1u
#define CARBON_EXTENSION_POINT_COUNT 10

/* ── lifecycle ───────────────────────────────────────────────────────── */

/*
 * lifecycle.register
 *
 * Install JS globals, start background threads, take the handles the
 * plugin needs. The only point that is effectively required: a plugin
 * exporting none of these does nothing.
 *
 * Runs AFTER the bundle. To install a global the app's own module-init
 * code will see, use `lifecycle.before_bundle_eval` instead.
 *
 * Must not block. Heavy initialisation (opening an audio device,
 * choosing a GPU adapter) belongs behind the first JS call that needs
 * it.
 *
 * Dispatch: Once, after the app bundle has been evaluated — so a plugin's
 * globals shadow the app's rather than the other way round.
 * Since:    ABI 1.0
 * Arity:    many
 * Requires: no capability — this point only observes
 */
void carbon_plugin_register(CarbonApp* app);

/*
 * lifecycle.before_bundle_eval
 *
 * The last moment at which a plugin can install a global the app's own
 * module-init code will see. `lifecycle.register` runs earlier and is
 * the right place for almost everything; this exists for globals that
 * must shadow, or be shadowed by, the bundle.
 *
 * Dispatch: Immediately before each evaluation of the app bundle — the
 * first one at startup, and every HMR re-evaluation after it.
 * Since:    ABI 1.1
 * Arity:    many
 * Requires: no capability — this point only observes
 */
void carbon_ext_lifecycle_before_bundle_eval(CarbonApp* app);

/*
 * lifecycle.before_reload
 *
 * Pause background threads and drop references to JS-owned values. The
 * JS context survives a reload, but every global installed from
 * `lifecycle.register` is about to be replaced.
 *
 * Dispatch: Before HMR re-evaluates the JS bundle.
 * Since:    ABI 1.0
 * Arity:    many
 * Requires: no capability — this point only observes
 */
void carbon_plugin_before_reload(CarbonApp* app);

/*
 * lifecycle.after_reload
 *
 * Re-install whatever `lifecycle.register` installed, and resume
 * background threads. A plugin that implements `before_reload` and not
 * this one has paused itself permanently.
 *
 * Dispatch: After the new JS bundle has finished evaluating.
 * Since:    ABI 1.0
 * Arity:    many
 * Requires: no capability — this point only observes
 */
void carbon_plugin_after_reload(CarbonApp* app);

/*
 * lifecycle.shutdown
 *
 * Join threads and flush external state. After this returns the shared
 * library is closed; a thread still running when that happens takes the
 * process with it.
 *
 * Dispatch: Once at exit, in REVERSE load order, before the library is
 * unloaded.
 * Since:    ABI 1.0
 * Arity:    many
 * Requires: no capability — this point only observes
 */
void carbon_plugin_on_shutdown(CarbonApp* app);

/* ── paint ───────────────────────────────────────────────────────────── */

/*
 * paint.before
 *
 * Read or write pixels. A GPU plugin blits its offscreen target into
 * the region belonging to its <canvas> node here.
 *
 * Capability-gated: a plugin that can write the framebuffer can draw
 * anything anywhere, including over UI the user is about to click.
 *
 * Dispatch: Every frame, after the rasterizer has drawn the scene and
 * before the pixmap is presented.
 * Since:    ABI 1.0
 * Arity:    many
 * Requires: paint.pixmap
 *
 * @param pixmap RGBA8, row-major, top-left origin, premultiplied alpha.
 * Valid only for this call.
 *
 * @param width Pixels.
 *
 * @param height Pixels.
 *
 * @param stride_bytes Bytes per row. Usually width*4, but rows may be
 * aligned — honour it.
 */
void carbon_plugin_before_paint(CarbonApp* app, uint8_t* pixmap, uint32_t width, uint32_t height, uint32_t stride_bytes);

/*
 * paint.after
 *
 * FPS counters, stats upload, frame pacing. The pixmap is gone by now —
 * this point cannot see or touch pixels, which is why it needs no
 * capability where `paint.before` does.
 *
 * Dispatch: Every frame, after present.
 * Since:    ABI 1.0
 * Arity:    many
 * Requires: no capability — this point only observes
 */
void carbon_plugin_after_paint(CarbonApp* app);

/* ── window ──────────────────────────────────────────────────────────── */

/*
 * window.resized
 *
 * Resize swapchains and offscreen targets. The arguments repeat what is
 * already on `app` — they are there so the common case needs no field
 * access.
 *
 * Dispatch: After the window resized and app->window_width/height were
 * updated.
 * Since:    ABI 1.0
 * Arity:    many
 * Requires: no capability — this point only observes
 *
 * @param width New width in logical pixels.
 *
 * @param height New height in logical pixels.
 */
void carbon_plugin_on_resize(CarbonApp* app, uint32_t width, uint32_t height);

/*
 * window.theme_changed
 *
 * Re-theme anything the plugin draws itself. A plugin that only renders
 * through JS does not need this — the app's own theme listener already
 * covers it.
 *
 * Dispatch: When the OS theme changes, alongside the JS
 * __cm_dispatch_theme_changed dispatch.
 * Since:    ABI 1.1
 * Arity:    many
 * Requires: no capability — this point only observes
 *
 * @param is_dark 1 when the OS reports a dark theme, 0 for light.
 */
void carbon_ext_window_theme_changed(CarbonApp* app, int32_t is_dark);

/* ── host ────────────────────────────────────────────────────────────── */

/*
 * host.resolve_asset
 *
 * NOT YET DISPATCHED. The loader binds this point and would call it,
 * but products/carbon has no asset-resolution path to call it FROM —
 * so a plugin implementing it today is never invoked.
 *
 * Declared anyway, as a deliberate compromise rather than an
 * oversight: it is the only point exercising `exclusive` arity and a
 * non-void return, so removing it would leave both untested end to
 * end. It is `.experimental`, the loader warns on use, and this
 * paragraph appears in all three generated artifacts.
 *
 * Wire it or remove it before ABI 1.1 ships.
 *
 * Answer where an asset lives. Exclusive because resolution is a
 * decision: two plugins returning different paths for one specifier
 * have no correct merge, so the loader refuses the second claimant
 * rather than letting load order decide.
 *
 * Return CARBON_OK when handled, CARBON_ERR_GENERIC to decline and let
 * the runtime carry on failing.
 *
 * Experimental: the resolved path is returned through a host call
 * rather than an out-parameter, and that shape is not settled.
 *
 * Dispatch: NOT YET DISPATCHED — see the doc. Intended: when the runtime
 * cannot resolve an asset specifier itself, before it reports a load
 * failure.
 * Since:    ABI 1.1
 * Arity:    exclusive — at most one plugin may implement it
 * Requires: fs.read
 *
 * EXPERIMENTAL: may change signature or disappear within ABI major 1.
 *
 * @param request The specifier as written by the app, e.g.
 * "asset:sprites/hero.png".
 */
int32_t carbon_ext_host_resolve_asset(CarbonApp* app, const char* request);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CARBON_EXTENSION_POINTS_H */
