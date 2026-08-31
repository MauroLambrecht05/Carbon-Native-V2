// The backend registry — which renderer backends exist and what each supports.
//
// This is a business rule, not a lookup table: the CLI picks a binary from it,
// the build pipeline branches on it, and carbon.toml validates against it. It
// lives in shared/ so there is exactly one answer, and it is mirrored by the
// `enum` on `runtime.backend` in shared/config/carbon.schema.json — the
// conformance test fails if the two drift apart.
//
// Adding a backend means adding a `[[bin]]` target to carbon/runtime/Cargo.toml
// (its own exclusive deps `optional = true`, gated behind a same-named
// feature — see that file's comments) and an entry here. Nothing else in the
// tree hardcodes a backend name.

/**
 * A backend is a `[[bin]]` target in the shared `carbon/runtime/Cargo.toml`
 * package (both backends live in one Cargo package now, selected at compile
 * time via `--bin` + `--features`, not one crate each — see that file).
 */
export interface Backend {
  /** Binary basename — matches the Cargo `[[bin]] name` (e.g. "carbon-mini").
   *  The Cargo feature that gates this backend's exclusive dependencies is
   *  the registry key itself (BACKENDS.mini → feature "mini"), not this field. */
  readonly crate: string;
  /** Shipping status. `experimental` backends are excluded from release builds. */
  readonly status: "stable" | "experimental";
  /** Consumes the mini bundle shape (Solid/React universal renderer output). */
  readonly usesMiniBundle: boolean;
  /** Implements QuickJS bytecode + heap-snapshot cold-start flags. */
  readonly supportsBytecode: boolean;
}

export const BACKENDS = {
  mini: {
    crate: "carbon-mini",
    status: "stable",
    usesMiniBundle: true,
    supportsBytecode: true,
  },
  blitz: {
    crate: "carbon-blitz",
    status: "experimental",
    usesMiniBundle: true,
    supportsBytecode: false,
  },
} as const satisfies Record<string, Backend>;

export type BackendName = keyof typeof BACKENDS;

/** The backend used when carbon.toml does not name one. */
export const DEFAULT_BACKEND: BackendName = "mini";

export const BACKEND_NAMES = Object.keys(BACKENDS) as BackendName[];
export const VALID_BACKENDS = BACKEND_NAMES.join(", ");

/**
 * Names accepted in carbon.toml that are not the canonical name.
 *
 * `mini-blitz` was the directory name before the backends moved under
 * runtime/. Apps in the wild have it written into their manifest, so it
 * resolves rather than erroring. Do not add aliases for new backends — this
 * map exists to honour manifests already on disk, not to allow synonyms.
 */
const ALIASES: Record<string, BackendName> = {
  "mini-blitz": "blitz",
};

/** Canonical name for whatever a manifest wrote, or null if unrecognised. */
export function normalizeBackend(name: unknown): BackendName | null {
  if (typeof name !== "string") return null;
  if (name in BACKENDS) return name as BackendName;
  return ALIASES[name] ?? null;
}

export function isBackend(name: unknown): name is BackendName {
  return normalizeBackend(name) !== null;
}

export function backend(name: BackendName): Backend {
  return BACKENDS[name];
}

/**
 * The `--features` value a `cargo build -p carbon-runtime --bin
 * carbon-<name> --no-default-features --features <this>` invocation needs.
 * The registry key doubles as the Cargo feature name; mini additionally
 * gets "snapshot" so a plain build keeps producing a snapshot-enabled
 * binary, matching carbon-mini's old per-crate default. Mirrored by
 * the crate_features on //products/carbon:mini and :blitz — keep both
 * in sync if backend-specific default features change.
 */
export interface RuntimeFeatureFlags {
  /** carbon.toml `[runtime] image` — links the image decoders. */
  readonly image?: boolean;
  /** carbon.toml `[runtime] audio` — links the Web Audio implementation. */
  readonly audio?: boolean;
  /** carbon.toml `[updater] enabled` — links the A/B slot state machine. */
  readonly updater?: boolean;
  /** `carbon build --release`'s static-plugin-linking path (see
   *  StaticLinkPluginsUseCase and carbon-plugin-host's own feature of the
   *  same name). Swaps the dlopen/dlsym plugin loader for one that expects
   *  every enabled plugin's code to already be linked into this exact
   *  binary — the caller MUST have built and pointed
   *  CARBON_STATIC_PLUGINS_LIB_DIR/_NAME at a matching umbrella first, or
   *  the link fails with an unresolved `carbon_plugin_register` and friends. */
  readonly staticPlugins?: boolean;
}

export function backendCargoFeatures(
  name: BackendName,
  flags: RuntimeFeatureFlags = {},
): string {
  const features = name === "mini" ? ["mini", "snapshot"] : [name];

  // ── WHY THE FLAGS MATTER ──────────────────────────────────────────────────
  // These subsystems are optional Cargo features AND runtime-gated by
  // carbon.toml. Both have to line up: the feature decides whether the code is
  // linked at all, the manifest decides whether it is switched on.
  //
  // This function used to ignore the manifest entirely, so an app declaring
  // `[runtime] image = true` got a runtime built without the image feature —
  // `maybe_register_image` compiled to its no-op stub and every image silently
  // failed to load, with nothing reporting why. Only mini has these.
  if (name === "mini") {
    if (flags.image) features.push("image");
    if (flags.audio) features.push("audio");
    if (flags.updater) features.push("updater");
  }
  // Both backends declare this feature (see their respective Cargo.toml
  // entries forwarding to carbon-plugin-host/static-plugins), so it's pushed
  // unconditionally on `name`, unlike the mini-only flags above.
  if (flags.staticPlugins) features.push("static-plugins");

  return features.join(",");
}
