// GENERATED — DO NOT EDIT.
//
// Source of truth: solutions/contracts/plugin/registry/extension-points.zig
// Regenerate:      carbon ext generate
// Verified by:     .tools/validation/check_extension_points.py

// The extension points a Carbon plugin may implement, as the toolchain sees
// them. The runtime enforces these; the toolchain's job is to say so before
// the app is launched, when the message can still name a file to edit.

export type ExtensionPointArity = "many" | "exclusive";
export type ExtensionPointStability = "stable" | "experimental";

/** Every id in the registry. A typo here is a compile error. */
export type ExtensionPointId =
  | "lifecycle.register"
  | "lifecycle.before_bundle_eval"
  | "lifecycle.before_reload"
  | "lifecycle.after_reload"
  | "lifecycle.shutdown"
  | "paint.before"
  | "paint.after"
  | "window.resized"
  | "window.theme_changed"
  | "host.resolve_asset";

export interface ExtensionPointParam {
  readonly name: string;
  /** The C spelling, for documentation and error messages. */
  readonly type: string;
  readonly doc: string;
}

export interface ExtensionPointSpec {
  readonly id: ExtensionPointId;
  /** The symbol a plugin exports to implement it. */
  readonly symbol: string;
  /** ABI minor this point appeared in. */
  readonly sinceMinor: number;
  readonly stability: ExtensionPointStability;
  readonly arity: ExtensionPointArity;
  /** Capability the host app must grant, or null when unprivileged. */
  readonly capability: string | null;
  readonly params: readonly ExtensionPointParam[];
  readonly returns: string;
  /** When the runtime calls it. */
  readonly dispatch: string;
  readonly doc: string;
}

/** The ABI minor implied by the registry. */
export const EXTENSION_POINTS_MINOR = 1;

export const EXTENSION_POINTS: readonly ExtensionPointSpec[] = [
  {
    id: "lifecycle.register",
    symbol: "carbon_plugin_register",
    sinceMinor: 0,
    stability: "stable",
    arity: "many",
    capability: null,
    params: [],
    returns: "void",
    dispatch: "Once, after the app bundle has been evaluated — so a plugin's globals shadow the app's rather than the other way round.",
    doc: "Install JS globals, start background threads, take the handles the\nplugin needs. The only point that is effectively required: a plugin\nexporting none of these does nothing.\n\nRuns AFTER the bundle. To install a global the app's own module-init\ncode will see, use `lifecycle.before_bundle_eval` instead.\n\nMust not block. Heavy initialisation (opening an audio device,\nchoosing a GPU adapter) belongs behind the first JS call that needs\nit.",
  },
  {
    id: "lifecycle.before_bundle_eval",
    symbol: "carbon_ext_lifecycle_before_bundle_eval",
    sinceMinor: 1,
    stability: "stable",
    arity: "many",
    capability: null,
    params: [],
    returns: "void",
    dispatch: "Immediately before each evaluation of the app bundle — the first one at startup, and every HMR re-evaluation after it.",
    doc: "The last moment at which a plugin can install a global the app's own\nmodule-init code will see. `lifecycle.register` runs earlier and is\nthe right place for almost everything; this exists for globals that\nmust shadow, or be shadowed by, the bundle.",
  },
  {
    id: "lifecycle.before_reload",
    symbol: "carbon_plugin_before_reload",
    sinceMinor: 0,
    stability: "stable",
    arity: "many",
    capability: null,
    params: [],
    returns: "void",
    dispatch: "Before HMR re-evaluates the JS bundle.",
    doc: "Pause background threads and drop references to JS-owned values. The\nJS context survives a reload, but every global installed from\n`lifecycle.register` is about to be replaced.",
  },
  {
    id: "lifecycle.after_reload",
    symbol: "carbon_plugin_after_reload",
    sinceMinor: 0,
    stability: "stable",
    arity: "many",
    capability: null,
    params: [],
    returns: "void",
    dispatch: "After the new JS bundle has finished evaluating.",
    doc: "Re-install whatever `lifecycle.register` installed, and resume\nbackground threads. A plugin that implements `before_reload` and not\nthis one has paused itself permanently.",
  },
  {
    id: "lifecycle.shutdown",
    symbol: "carbon_plugin_on_shutdown",
    sinceMinor: 0,
    stability: "stable",
    arity: "many",
    capability: null,
    params: [],
    returns: "void",
    dispatch: "Once at exit, in REVERSE load order, before the library is unloaded.",
    doc: "Join threads and flush external state. After this returns the shared\nlibrary is closed; a thread still running when that happens takes the\nprocess with it.",
  },
  {
    id: "paint.before",
    symbol: "carbon_plugin_before_paint",
    sinceMinor: 0,
    stability: "stable",
    arity: "many",
    capability: "paint.pixmap",
    params: [
      {
        name: "pixmap",
        type: "uint8_t*",
        doc: "RGBA8, row-major, top-left origin, premultiplied alpha. Valid only for this call.",
      },
      {
        name: "width",
        type: "uint32_t",
        doc: "Pixels.",
      },
      {
        name: "height",
        type: "uint32_t",
        doc: "Pixels.",
      },
      {
        name: "stride_bytes",
        type: "uint32_t",
        doc: "Bytes per row. Usually width*4, but rows may be aligned — honour it.",
      },
    ],
    returns: "void",
    dispatch: "Every frame, after the rasterizer has drawn the scene and before the pixmap is presented.",
    doc: "Read or write pixels. A GPU plugin blits its offscreen target into\nthe region belonging to its <canvas> node here.\n\nCapability-gated: a plugin that can write the framebuffer can draw\nanything anywhere, including over UI the user is about to click.",
  },
  {
    id: "paint.after",
    symbol: "carbon_plugin_after_paint",
    sinceMinor: 0,
    stability: "stable",
    arity: "many",
    capability: null,
    params: [],
    returns: "void",
    dispatch: "Every frame, after present.",
    doc: "FPS counters, stats upload, frame pacing. The pixmap is gone by now —\nthis point cannot see or touch pixels, which is why it needs no\ncapability where `paint.before` does.",
  },
  {
    id: "window.resized",
    symbol: "carbon_plugin_on_resize",
    sinceMinor: 0,
    stability: "stable",
    arity: "many",
    capability: null,
    params: [
      {
        name: "width",
        type: "uint32_t",
        doc: "New width in logical pixels.",
      },
      {
        name: "height",
        type: "uint32_t",
        doc: "New height in logical pixels.",
      },
    ],
    returns: "void",
    dispatch: "After the window resized and app->window_width/height were updated.",
    doc: "Resize swapchains and offscreen targets. The arguments repeat what is\nalready on `app` — they are there so the common case needs no field\naccess.",
  },
  {
    id: "window.theme_changed",
    symbol: "carbon_ext_window_theme_changed",
    sinceMinor: 1,
    stability: "stable",
    arity: "many",
    capability: null,
    params: [
      {
        name: "is_dark",
        type: "int32_t",
        doc: "1 when the OS reports a dark theme, 0 for light.",
      },
    ],
    returns: "void",
    dispatch: "When the OS theme changes, alongside the JS __cm_dispatch_theme_changed dispatch.",
    doc: "Re-theme anything the plugin draws itself. A plugin that only renders\nthrough JS does not need this — the app's own theme listener already\ncovers it.",
  },
  {
    id: "host.resolve_asset",
    symbol: "carbon_ext_host_resolve_asset",
    sinceMinor: 1,
    stability: "experimental",
    arity: "exclusive",
    capability: "fs.read",
    params: [
      {
        name: "request",
        type: "const char*",
        doc: "The specifier as written by the app, e.g. \"asset:sprites/hero.png\".",
      },
    ],
    returns: "int32_t",
    dispatch: "NOT YET DISPATCHED — see the doc. Intended: when the runtime cannot resolve an asset specifier itself, before it reports a load failure.",
    doc: "NOT YET DISPATCHED. The loader binds this point and would call it,\nbut products/carbon has no asset-resolution path to call it FROM —\nso a plugin implementing it today is never invoked.\n\nDeclared anyway, as a deliberate compromise rather than an\noversight: it is the only point exercising `exclusive` arity and a\nnon-void return, so removing it would leave both untested end to\nend. It is `.experimental`, the loader warns on use, and this\nparagraph appears in all three generated artifacts.\n\nWire it or remove it before ABI 1.1 ships.\n\nAnswer where an asset lives. Exclusive because resolution is a\ndecision: two plugins returning different paths for one specifier\nhave no correct merge, so the loader refuses the second claimant\nrather than letting load order decide.\n\nReturn CARBON_OK when handled, CARBON_ERR_GENERIC to decline and let\nthe runtime carry on failing.\n\nExperimental: the resolved path is returned through a host call\nrather than an out-parameter, and that shape is not settled.",
  },
] as const;

const BY_ID = new Map<string, ExtensionPointSpec>(
  EXTENSION_POINTS.map((point) => [point.id, point]),
);

/** The point with this id, or undefined. */
export function extensionPoint(id: string): ExtensionPointSpec | undefined {
  return BY_ID.get(id);
}

export function isExtensionPointId(id: string): id is ExtensionPointId {
  return BY_ID.has(id);
}

/** Every id, for error messages that should list the alternatives. */
export const EXTENSION_POINT_IDS: readonly string[] =
  EXTENSION_POINTS.map((point) => point.id);

/**
 * Every capability some point gates on. A host app granting none of these
 * can still load a plugin — most points only observe — so this is the list
 * of grants that unlock something, not a list of requirements.
 */
export const EXTENSION_POINT_CAPABILITIES: readonly string[] = [
  "fs.read",
  "paint.pixmap",
];
