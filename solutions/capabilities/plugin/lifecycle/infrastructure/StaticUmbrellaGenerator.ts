// Generates the "umbrella" Zig package that `StaticLinkPluginsUseCase`
// builds into one static lib for `carbon build --release`.
//
// ── THE MECHANISM, IN ONE SENTENCE ──────────────────────────────────────────
// Every plugin's own src/main.zig already implements each extension point as
// `pub fn <registry symbol>(...)` (via `sdk.ext.implement` — see
// extension_points.zig in the Zig SDK), NOT as a globally-exported `export
// fn`, whenever it's compiled with `-Dplugin-linkage=static`; this file
// `@import`s every enabled plugin's main.zig as its own distinctly-named
// module (Zig namespaces `@import`s, so two plugins' same-named `pub fn`s
// never collide) and is the ONLY place that still emits real `export fn`s —
// one per registry point, fanning out to every enabled plugin that
// implements it, in manifest order. See extension_points.zig's
// `implement`/`implementManifest` doc comments for the other half of this.
//
// The generated `export fn`s are exactly the symbol names/signatures
// `plugin_loader_static.rs`'s `extern "C"` block already declares — ALL 10
// registry points, unconditionally, even ones nothing implements (a no-op
// body then), plus one meta symbol, `carbon_plugin_static_count`. That is
// the fixed contract between this generator and the Rust side; see
// plugin_loader_static.rs's own header comment.
//
// `carbon_plugin_manifest` is deliberately NOT re-exported here — a
// statically-linked plugin has no runtime manifest introspection to serve
// (see implementManifest's doc comment); StaticLinkPluginsUseCase already
// validated every enabled plugin's carbon-plugin.toml BEFORE this generator
// runs, which is the build-time equivalent of what a dynamic loader would
// otherwise use the manifest for at launch.

import { relative } from "node:path";
import { forwardSlashes } from "../application/usecases/CreatePluginUseCase.ts";
import {
  EXTENSION_POINTS,
  type ExtensionPointParam,
  type ExtensionPointSpec,
} from "@carbon/contracts/plugin/extension-points";
import { ExclusivePointConflictError } from "../domain/errors/PluginError.ts";

export interface UmbrellaPlugin {
  readonly name: string;
  /**
   * Absolute path to this plugin's `src/main.zig`, already resolved by the
   * caller — NOT derived here from a single `pluginsRoot` + name, because
   * where it lives genuinely differs by source:
   *   - `local` plugins are authored directly inside the app, so their real
   *     source sits at `<host>/carbon/plugins/local/<name>/src/main.zig`.
   *   - `vendor` (carbon-sdk) plugins do NOT have their source copied into
   *     an app at all — InstallPluginUseCase only ever copies the COMPILED
   *     artifact + carbon-plugin.toml into `carbon/plugins/vendor/<name>/`
   *     (see its own header comment). Static linking needs real Zig
   *     source, so a vendor plugin's `mainZigPath` must point at its
   *     canonical location instead: `<standardPluginsRoot>/<name>/src/
   *     main.zig` — the exact directory AddStandardPluginUseCase already
   *     builds FROM for the dynamic path, never a per-app copy.
   */
  readonly mainZigPath: string;
  /** Extension-point ids this plugin declares AND the registry recognizes
   *  (StaticLinkPluginsUseCase has already filtered/validated this list). */
  readonly points: readonly string[];
}

export interface UmbrellaFiles {
  readonly "umbrella.zig": string;
  readonly "build.zig": string;
  readonly "build.zig.zon": string;
}

/** Fixed name+fingerprint pair for the generated package — a `zig build`
 *  package name never changes between runs (it's not user-facing), so its
 *  fingerprint (a hash Zig derives FROM the name, and refuses to guess) is a
 *  constant computed once. Recompute by running `zig build` against a stub
 *  build.zig.zon carrying only `.name` and letting the "use this value"
 *  error hand back the real one, exactly as this one was.
 */
const UMBRELLA_PACKAGE_NAME = "carbon_static_plugins_umbrella";
const UMBRELLA_FINGERPRINT = "0xf436e14387937807";

const C_TO_ZIG_PARAM: Record<string, string> = {
  "uint8_t*": "[*]u8",
  "uint32_t": "u32",
  "int32_t": "i32",
  "const char*": "[*:0]const u8",
};

const C_TO_ZIG_RETURN: Record<string, string> = {
  void: "void",
  "int32_t": "i32",
};

/** The value a no-op stub returns when nothing implements a point. Only
 *  `host.resolve_asset` returns non-void today (`int32_t`, CARBON_OK==0) —
 *  a stub declines by returning non-zero, same shape `jsReadText`-style
 *  "nothing to answer" paths elsewhere in this codebase use. */
function noopReturn(spec: ExtensionPointSpec): string {
  if (spec.returns === "void") return "";
  if (spec.returns === "int32_t") return "return -1;";
  throw new Error(`StaticUmbrellaGenerator: no no-op value known for return type "${spec.returns}"`);
}

function zigParam(p: ExtensionPointParam): string {
  const type = C_TO_ZIG_PARAM[p.type];
  if (!type) throw new Error(`StaticUmbrellaGenerator: no Zig type mapping for C type "${p.type}" (param "${p.name}")`);
  return `${zigIdentifier(p.name)}: ${type}`;
}

/** A plugin name (e.g. "global-shortcuts", "carbon-pulse") as a valid Zig
 *  identifier for both the `@import` alias and any generated local var —
 *  Zig identifiers can't contain hyphens. */
export function zigIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `p_${cleaned}` : cleaned;
}

/**
 * The `zig build -Dtarget=` triple matching the CURRENT host's default Rust
 * link ABI — required so the umbrella's static lib and `cargo build`'s
 * default-target `carbon-runtime` binary agree (see build.rs's own comment,
 * and the milestone-1 spike this was validated against for Windows/MSVC
 * specifically).
 *
 * KNOWN GAP: only the win32 rows were verified empirically this session (no
 * Linux/macOS machine available). The linux/darwin rows follow Zig's
 * documented triple convention (`<arch>-<os>-<abi>`, `none` ABI on Darwin)
 * but have not been built-and-linked end to end the way Windows was — worth
 * a real CI run on those platforms before relying on them.
 */
export function hostZigTargetTriple(platform: NodeJS.Platform, arch: string): string {
  const zigArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!zigArch) throw new Error(`StaticUmbrellaGenerator: unsupported arch "${arch}" for a static release build`);

  switch (platform) {
    case "win32":
      return `${zigArch}-windows-msvc`;
    case "linux":
      return `${zigArch}-linux-gnu`;
    case "darwin":
      return `${zigArch}-macos-none`;
    default:
      throw new Error(`StaticUmbrellaGenerator: unsupported platform "${platform}" for a static release build`);
  }
}

/**
 * Build the three files a `zig build` in the umbrella directory needs.
 *
 * @param umbrellaDir where these files will be written (only used to compute
 *   relative paths to the SDK and to each plugin's main.zig — this function
 *   itself does not touch disk).
 * @param sdkComposition `products/carbon-ext/composition` (or wherever this
 *   toolchain install's SDK package root lives) — same directory
 *   `CreatePluginUseCase` points a scaffolded plugin's build.zig.zon at.
 */
export function generateUmbrella(
  umbrellaDir: string,
  sdkComposition: string,
  plugins: readonly UmbrellaPlugin[],
  target: { platform: NodeJS.Platform; arch: string },
): UmbrellaFiles {
  // ── Which plugin(s) implement each point, validating exclusivity ────────
  const implementorsByPoint = new Map<string, UmbrellaPlugin[]>();
  for (const spec of EXTENSION_POINTS) implementorsByPoint.set(spec.id, []);
  for (const plugin of plugins) {
    for (const id of plugin.points) {
      implementorsByPoint.get(id)?.push(plugin);
    }
  }
  for (const spec of EXTENSION_POINTS) {
    const implementors = implementorsByPoint.get(spec.id)!;
    if (spec.arity === "exclusive" && implementors.length > 1) {
      throw new ExclusivePointConflictError(spec.id, implementors.map((p) => p.name));
    }
  }

  // ── umbrella.zig ─────────────────────────────────────────────────────────
  // `@import("<plugin name>")`, NOT a relative file path: Zig 0.16 refuses
  // an `@import` whose relative path would step outside the importing
  // module's own root ("import of file outside module path") — confirmed
  // empirically, not a style choice. build.zig below gives each plugin its
  // OWN independently-rooted module (root_source_file = its real main.zig,
  // wherever that actually lives) and wires it to this one via
  // `mod.addImport(p.name, ...)`; this `@import` just names that same edge.
  const imports = plugins
    .map((p) => `const ${zigIdentifier(p.name)} = @import("${p.name}");`)
    .join("\n");

  const exportedPoints = EXTENSION_POINTS.map((spec) => {
    const implementors = implementorsByPoint.get(spec.id)!;
    const params = ["app: *anyopaque", ...spec.params.map(zigParam)].join(", ");
    const returnType = C_TO_ZIG_RETURN[spec.returns];
    if (returnType === undefined) {
      throw new Error(`StaticUmbrellaGenerator: no Zig return-type mapping for "${spec.returns}"`);
    }
    const argNames = ["@ptrCast(@alignCast(app))", ...spec.params.map((p) => zigIdentifier(p.name))].join(", ");

    // Zig treats an unused function parameter as a hard error, so a no-op
    // stub (below) must explicitly discard every one of them — including
    // `app`, which real implementor bodies always end up using via the
    // `@ptrCast` call but a stub never touches at all.
    const allParamNames = ["app", ...spec.params.map((p) => zigIdentifier(p.name))];
    const discardAll = `    _ = .{ ${allParamNames.join(", ")} };\n`;

    let body: string;
    if (implementors.length === 0) {
      const ret = noopReturn(spec);
      body = discardAll + (ret ? `    ${ret}\n` : "");
    } else if (returnType === "void") {
      body = implementors.map((p) => `    ${zigIdentifier(p.name)}.${spec.symbol}(${argNames});`).join("\n") + "\n";
    } else {
      // Only `host.resolve_asset` returns non-void, and it's `exclusive`
      // arity (enforced above) — so there is exactly one implementor here,
      // never a merge-multiple-results question.
      body = `    return ${zigIdentifier(implementors[0].name)}.${spec.symbol}(${argNames});\n`;
    }

    return `export fn ${spec.symbol}(${params}) callconv(.c) ${returnType} {\n${body}}`;
  }).join("\n\n");

  const umbrellaZig = `// GENERATED by StaticLinkPluginsUseCase for a \`carbon build --release\`
// static-plugins binary. Not meant to be hand-edited or committed — see
// StaticUmbrellaGenerator.ts's header comment for the mechanism.
${imports}

${exportedPoints}

export fn carbon_plugin_static_count() callconv(.c) u32 {
    return ${plugins.length};
}
`;

  // ── build.zig ────────────────────────────────────────────────────────────
  const sdkPath = forwardSlashes(relative(umbrellaDir, sdkComposition));
  const targetTriple = hostZigTargetTriple(target.platform, target.arch);

  const pluginModules = plugins
    .map((p) => {
      const ident = zigIdentifier(p.name);
      const mainZig = forwardSlashes(relative(umbrellaDir, p.mainZigPath));
      return [
        `    const ${ident}_mod = b.createModule(.{`,
        `        .root_source_file = b.path("${mainZig}"),`,
        `        .target = target,`,
        `        .optimize = optimize,`,
        `        .link_libc = true,`,
        `    });`,
        `    ${ident}_mod.addImport("carbon_sdk", sdk.module("carbon_sdk"));`,
        `    ${ident}_mod.addIncludePath(sdk.path("../presentation/include"));`,
        `    mod.addImport("${p.name}", ${ident}_mod);`,
      ].join("\n");
    })
    .join("\n");

  const buildZig = `// GENERATED by StaticLinkPluginsUseCase. See StaticUmbrellaGenerator.ts.
const std = @import("std");

pub fn build(b: *std.Build) void {
    // Pinned to match cargo's default link ABI on this host, not Zig's own
    // "native" autodetection — see hostZigTargetTriple's doc comment.
    const target = b.resolveTargetQuery(std.Target.Query.parse(.{
        .arch_os_abi = "${targetTriple}",
    }) catch unreachable);
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseFast });

    const sdk = b.dependency("carbon-plugin-sdk", .{
        .target = target,
        .optimize = optimize,
        .@"plugin-linkage" = .static,
    });
${plugins.length === 0 ? "    _ = sdk; // no enabled plugins — nothing below imports it, and Zig treats an unused local as a hard error\n" : ""}
    const mod = b.createModule(.{
        .root_source_file = b.path("umbrella.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

${pluginModules}

    const lib = b.addLibrary(.{
        .linkage = .static,
        // Must match CARBON_STATIC_PLUGINS_LIB_NAME in build.rs / the env
        // var StaticLinkPluginsUseCase sets before invoking cargo.
        .name = "carbon_plugins_umbrella",
        .root_module = mod,
    });
    b.installArtifact(lib);
}
`;

  // ── build.zig.zon ────────────────────────────────────────────────────────
  const buildZigZon = `.{
    .name = .${UMBRELLA_PACKAGE_NAME},
    .fingerprint = ${UMBRELLA_FINGERPRINT},
    .version = "0.0.0",
    .minimum_zig_version = "0.13.0",
    .dependencies = .{
        .@"carbon-plugin-sdk" = .{
            .path = "${sdkPath}",
        },
    },
    .paths = .{""},
}
`;

  return {
    "umbrella.zig": umbrellaZig,
    "build.zig": buildZig,
    "build.zig.zon": buildZigZon,
  };
}
