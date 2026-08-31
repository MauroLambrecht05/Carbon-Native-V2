// Why a plugin operation refused.
//
// Typed for the same reason as the scaffolding errors: the CLI answers each of
// these differently, and `log.error` plus `return 1` made them indistinguishable
// to any caller that was not a terminal.

export abstract class PluginError extends Error {
  abstract readonly kind: string;
}

export class UnknownLanguageError extends PluginError {
  readonly kind = "unknown-language";
  constructor(requested: string, available: readonly string[]) {
    super(`unknown plugin language "${requested}" — expected ${available.join(" or ")}`);
  }
}

export class TargetNotEmptyError extends PluginError {
  readonly kind = "target-not-empty";
  constructor(readonly target: string) {
    super(`${target} already exists and is not empty`);
  }
}

/** No build.zig, so there is nothing to build. */
export class NotAPluginDirectoryError extends PluginError {
  readonly kind = "not-a-plugin";
  constructor(readonly directory: string) {
    super(
      `no build.zig found in ${directory} — a carbon plugin is a Zig project. ` +
        "Scaffold one with: carbon plugin new <name>",
    );
  }
}

export class ArtifactNotFoundError extends PluginError {
  readonly kind = "artifact-not-found";
  constructor(readonly plugin: string, readonly tried: readonly string[]) {
    super(`no built artifact found for ${plugin}; tried: ${tried.join(", ")}`);
  }
}

/** `install` has to know which app to install into. */
export class NoHostAppError extends PluginError {
  readonly kind = "no-host-app";
  constructor(readonly from: string) {
    super(
      `no carbon.toml found from ${from} upward — install needs to know which app to install into`,
    );
  }
}

export class PluginNotFoundError extends PluginError {
  readonly kind = "plugin-not-found";
  constructor(readonly name: string) {
    super(`no plugin named ${name} found`);
  }
}

/** `carbon plugin add <name>` (or an auto-heal of a vendor entry) asked for
 *  a name carbon-sdk does not have. */
export class UnknownStandardPluginError extends PluginError {
  readonly kind = "unknown-standard-plugin";
  constructor(readonly name: string, readonly available: readonly string[]) {
    super(
      `no standard plugin named "${name}"` +
        (available.length ? ` — available: ${available.join(", ")}` : ""),
    );
  }
}

/** `carbon build --release`'s static-link path: the same problems
 *  PreflightPluginsUseCase would only WARN about (a plugin the dynamic
 *  loader would silently skip at every launch) instead fail the build —
 *  see StaticLinkPluginsUseCase's own header comment for why that's the
 *  right tradeoff for a release artifact. */
export class StaticLinkValidationError extends PluginError {
  readonly kind = "static-link-validation";
  constructor(readonly problems: readonly { plugin: string; message: string; fix?: string }[]) {
    super(
      `${problems.length} plugin problem(s) would prevent a static release build:\n` +
        problems
          .map((p) => `  [plugins.${p.plugin}] ${p.message}${p.fix ? ` (fix: ${p.fix})` : ""}`)
          .join("\n"),
    );
  }
}

/** Two enabled plugins both declare the same `arity = exclusive` extension
 *  point — mirrors plugin_loader.rs's runtime `exclusive_claims` refusal,
 *  just caught at build time instead of load order deciding a winner. */
export class ExclusivePointConflictError extends PluginError {
  readonly kind = "exclusive-point-conflict";
  constructor(readonly point: string, readonly claimants: readonly string[]) {
    super(
      `"${point}" is an exclusive extension point and more than one enabled plugin implements it: ` +
        `${claimants.join(", ")}. Disable one of them in carbon/manifest.toml.`,
    );
  }
}

/** The generated umbrella failed to build — a `zig build` failure inside
 *  the umbrella directory, not a validation problem. */
export class StaticUmbrellaBuildError extends PluginError {
  readonly kind = "static-umbrella-build-failed";
  constructor(readonly exitCode: number) {
    super(`the static plugin umbrella failed to build — zig build exited with code ${exitCode}. See the compiler output above.`);
  }
}
