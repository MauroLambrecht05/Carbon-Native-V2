// Locates the carbon-native V2 workspace root and the artifacts inside it.
//
// Every path is computed by *searching* for a workspace marker, so anything
// importing @carbon/toolchain resolves the same paths no matter what directory
// the user invoked from, and no matter where the compiled binary was copied.
//
// PORTED FROM V1 (shared/logic/ts/src/paths.ts). This is the one module in the
// port that could not be lifted verbatim: every constant here encodes the
// repository layout, and V2's layout is different. The exported names, their
// types and their meanings are unchanged — only what they point at moved.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKENDS, type BackendName } from "@carbon/contracts/app/backend";

/**
 * Files that mark a carbon workspace root. MODULE.bazel is the primary one —
 * it is the Bazel workspace root by definition, and the workspace root is the
 * only place it may live. The tsconfig is a secondary marker so a source-mode
 * checkout still resolves if Bazel is ever dropped.
 */
const WORKSPACE_MARKERS = ["MODULE.bazel", ".config/tsconfig.base.json"];

/**
 * Nearest ancestor of `start` (inclusive) containing a workspace marker.
 * Returns null when no workspace is found — safe to call from anywhere,
 * including a globally-installed binary outside any workspace.
 */
export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    for (const marker of WORKSPACE_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
/**
 * Locates the workspace root, by search rather than by arithmetic.
 *
 * This used to count directory levels: three up from the compiled binary, five
 * up from this source file. That works only while the binary stays in its
 * build location. Copy `carbon.exe` onto your PATH — the entire point of
 * compiling it — and three-up from `C:\bin` resolves to something like
 * `C:\Users\<you>\AppData`, so every repo-relative path silently points at
 * nonsense. Searching for a marker fixes that, and is immune to either tree
 * being restructured.
 *
 * Order:
 *   1. $CARBON_ROOT, if set — the explicit escape hatch.
 *   2. Upward from the executable/source file: the in-tree case.
 *   3. Upward from the current directory: the installed-on-PATH case, where
 *      the workspace you mean is the one you are standing in.
 *   4. The old level-counting, as a last resort.
 */
function resolveCarbonRoot(): string {
  const override = process.env.CARBON_ROOT;
  if (override) return resolve(override);

  const metaUrl = import.meta.url;
  // Bun's compiled-binary VFS uses paths like:
  //   POSIX:   file:///$bunfs/root/<name>
  //   Windows: file:///B:/~BUN/root/<name>     (URL-encoded as %7EBUN)
  // In that case import.meta.url is synthetic and says nothing about where the
  // .exe actually sits; process.execPath does.
  const isCompiled =
    metaUrl.includes("/$bunfs/") ||
    metaUrl.includes("/~BUN/") ||
    metaUrl.includes("/%7EBUN/") ||
    metaUrl.includes("/%7Ebun/");

  const anchor = isCompiled
    ? dirname(process.execPath)
    : dirname(fileURLToPath(metaUrl));

  return (
    findWorkspaceRoot(anchor) ??
    findWorkspaceRoot(process.cwd()) ??
    (isCompiled
      ? resolve(anchor, "..", "..", "..")
      : resolve(anchor, "..", "..", "..", "..", ".."))
  );
}

export const CARBON_ROOT = resolveCarbonRoot();

// ── The V2 tiers ────────────────────────────────────────────────────────────
// products/ holds shipping binaries and CLIs, solutions/ holds everything they
// are built out of, labs/ holds experimental spikes, .tools/ is developer
// automation that never ships.
export const PRODUCTS_DIR = join(CARBON_ROOT, "products");
export const SOLUTIONS_DIR = join(CARBON_ROOT, "solutions");
export const LABS_DIR = join(CARBON_ROOT, "labs");
export const TOOLS_DIR = join(CARBON_ROOT, ".tools");

// The five tiers. These replaced shared/ internal/ external/, which this file
// still described long after they stopped existing — every constant below
// pointed at an absent directory, and nothing noticed because nothing read
// them. That is the failure this file's own header warns about, and it landed
// anyway; the paths that ARE read are grouped at the bottom for that reason.
export const CONTRACTS_DIR = join(SOLUTIONS_DIR, "contracts");
export const CAPABILITIES_DIR = join(SOLUTIONS_DIR, "capabilities");
export const INFRASTRUCTURE_DIR = join(SOLUTIONS_DIR, "infrastructure");
export const INTEGRATIONS_DIR = join(SOLUTIONS_DIR, "integrations");
export const INTERFACE_DIR = join(SOLUTIONS_DIR, "interface");

/** The C-ABI header a plugin author compiles against. */
export const ABI_DIR = join(CONTRACTS_DIR, "plugin", "abi");
/** carbon.toml JSON Schema — one of three renderings of that contract. */
export const CARBON_SCHEMA = join(CONTRACTS_DIR, "app", "schema", "carbon.schema.json");

export const CONFIG_DIR = join(CARBON_ROOT, ".config");
export const SCRIPTS_DIR = TOOLS_DIR;

/**
 * The publish-time delta tool, or null when it has not been built.
 *
 * This replaced VENDOR_DIR, which pointed at two prebuilt Windows executables
 * committed at .tools/vendor — `bsdiff.exe` and `zig-zstd.exe`. They made
 * `carbon publish` a Windows-only command and they were the only committed
 * binaries in the repository. `carbon-delta` is built from
 * solutions/capabilities/publishing/rust like any other crate.
 *
 * Searches BINARY_PROFILES in preference order, the same way a runtime binary
 * is resolved — a release build wins over a debug one when both exist.
 */
export function resolveDeltaTool(): string | null {
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const profile of BINARY_PROFILES) {
    const candidate = join(TARGET_DIR, profile, `carbon-delta${exe}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The Cargo workspace: the manifest, the lockfile, and the target directory
 * cargo writes into.
 *
 * Beside the Bazel rules that drive it. It was `.config/rust`, which put a
 * 17-member workspace manifest in the tier that holds configuration, next to
 * `.config/toolchains/rust/` — two directories called `rust` in one place.
 */
export const CARGO_WORKSPACE_DIR = join(TOOLS_DIR, "orchestration", "bazel", "cargo");

/**
 * Source files the build pipeline reads directly rather than importing.
 *
 * These used to be `new URL("../../…", import.meta.url)` hops computed from
 * whichever file happened to need them, so every directory move silently broke
 * them — and only on the code paths that read them. Anchoring to CARBON_ROOT
 * means a move breaks them here, once, loudly.
 */
export const BUILD_PLUGINS_DIR = join(INTEGRATIONS_DIR, "bundler");
export const TAILWIND_CLASSES_SRC = join(
  INTEGRATIONS_DIR, "bundler", "vite", "domain", "tailwind-classes.ts",
);

/**
 * Cargo build output. One workspace → one target directory, so every backend
 * binary lands in the same place regardless of which crate produced it.
 */
// `target/` beside the Cargo workspace manifest, and it must match
// CARGO_TARGET_DIR in .tools/orchestration/bazel/cargo/defs.bzl and
// `target-dir` in .cargo/config.toml exactly. All three have disagreed before,
// and the symptom is a binary that builds and cannot be found —
// //.tools/validation:workspace_test compares them.
export const TARGET_DIR = join(CARGO_WORKSPACE_DIR, "target");

/**
 * Profiles searched for a runtime binary, in preference order.
 *
 * `dist` is the shipping profile (opt-level "z", fat LTO); `release` is the
 * everyday one. Preferring dist means that once a release build exists,
 * `carbon run` launches the binary users actually get.
 */
export const BINARY_PROFILES = ["dist", "release"] as const;

// ── Not yet migrated ────────────────────────────────────────────────────────
// The anchors below name V2 directories that phases 3–5 of the migration have
// not created yet (the Rust/C++/Zig runtime, the stdlib, the renderers). They
// are kept — rather than deleted — because the build pipeline imports them by
// name, and because their V2 home is already decided even though it is empty.
//
// Anything reading one of these today gets a path that does not exist. That is
// the honest state of the port: the CLI's build pipeline cannot compile a
// runtime until there is a runtime in V2 to compile.

/** products/carbon — the Cargo package both runtime binaries live in. */
export const RUNTIME_DIR = join(PRODUCTS_DIR, "carbon");
/** interface/stdlib — the app-facing TypeScript surface. */
export const STDLIB_DIR = join(INTERFACE_DIR, "stdlib");
/** interface/renderer — solid and react, which turn JSX into host calls. */
export const RENDERERS_DIR = join(INTERFACE_DIR, "renderer");
export const EXAMPLES_DIR = join(LABS_DIR, "examples");

export const CSS_ENGINE_SRC = join(STDLIB_DIR, "dom", "css.ts");

/**
 * Source directory of the Cargo package both backends share.
 *
 * Both `carbon-mini` and `carbon-blitz` are `[[bin]]` targets in one Cargo
 * package, so this ignores `backend` and always returns the same directory —
 * kept as a per-backend function so callers that loop over BACKEND_NAMES
 * checking "does this backend's crate exist on disk" don't need to change.
 */
export function backendCrateDir(_backend: BackendName): string {
  return RUNTIME_DIR;
}

/**
 * Where a backend's JS-side universal renderers live. Only mini has renderers
 * today (react/solid target its scene graph specifically); they live under the
 * paint engine crate, not under a per-backend directory.
 */
export function backendRenderersDir(_backend: BackendName): string {
  return RENDERERS_DIR;
}

/**
 * Modules the build pipeline *injects* into an app rather than the app
 * importing them itself — the React reconciler that replaces react-dom, and
 * the DOM-compat install shim.
 *
 * They must resolve to workspace paths, not to the app's node_modules. Bun's
 * isolated linker gives each package only what its own package.json declares,
 * so an injected specifier the app never declared cannot resolve from the
 * app's directory. This is the same reason TAILWIND_CLASSES_SRC exists.
 */
export const MINI_REACT_SRC = join(RENDERERS_DIR, "react", "index.ts");
/** The Solid renderer a scaffolded project depends on. */
export const MINI_SOLID_SRC = join(RENDERERS_DIR, "solid", "index.ts");
export const COMPAT_DOM_INSTALL_SRC = join(STDLIB_DIR, "dom", "globals", "install.ts");
export const COMPAT_DOM_SRC = join(STDLIB_DIR, "dom", "index.ts");

/**
 * The injected packages' SUBPATH entries, one constant each.
 *
 * The build pipeline used to derive these with `join(dirname(MINI_REACT_SRC),
 * "jsx-runtime.ts")` — which reads as "next to the renderer's index" and is
 * really "I know how that package is laid out inside". It broke the moment the
 * renderers grew directories. A subpath is part of a package's public surface
 * (each one has a matching `exports` entry in its package.json); naming them
 * here keeps the pipeline resolving entries rather than guessing at files.
 */
export const MINI_REACT_JSX_RUNTIME_SRC = join(RENDERERS_DIR, "react", "runtime", "jsx-runtime.ts");
export const MINI_SOLID_POLYFILLS_SRC = join(RENDERERS_DIR, "solid", "runtime", "polyfills.ts");
export const MINI_SOLID_IMAGE_SRC = join(RENDERERS_DIR, "solid", "intrinsics", "image.ts");

/** Path a backend binary would occupy under a given profile, built or not. */
export function backendBinaryPath(backend: BackendName, profile: string = "release"): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  return join(TARGET_DIR, profile, `${BACKENDS[backend].crate}${exe}`);
}

/**
 * The backend binary to actually spawn, or null if it has not been built.
 * Searches BINARY_PROFILES in order.
 */
export function resolveBackendBinary(backend: BackendName): string | null {
  for (const profile of BINARY_PROFILES) {
    const p = backendBinaryPath(backend, profile);
    if (existsSync(p)) return p;
  }
  return null;
}

export function backendBinaryExists(backend: BackendName): boolean {
  return resolveBackendBinary(backend) !== null;
}

// ── Compatibility shims ──────────────────────────────────────────────────────
// Older call sites in the build pipeline use these names. They forward to the
// backend registry so there is still one source of truth.

/** @deprecated use `backendBinaryPath` / `resolveBackendBinary`. */
export const runtimeBinaryPath = backendBinaryPath;
/** @deprecated use `backendCrateDir`. */
export const runtimeCargoDir = backendCrateDir;
/** @deprecated use `backendBinaryExists`. */
export const runtimeBinaryExists = backendBinaryExists;

/** Both current backends consume the same Solid/React bundle shape. */
export function usesMiniBundlePipeline(backend: BackendName): boolean {
  return BACKENDS[backend].usesMiniBundle;
}

/** QuickJS bytecode + heap-snapshot flags are implemented by carbon-mini. */
export function supportsMiniBytecode(backend: BackendName): boolean {
  return BACKENDS[backend].supportsBytecode;
}
