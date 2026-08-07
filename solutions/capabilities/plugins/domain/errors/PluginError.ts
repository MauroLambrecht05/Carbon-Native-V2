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

/** Neither a Cargo.toml nor a build.zig, so there is nothing to build. */
export class NotAPluginDirectoryError extends PluginError {
  readonly kind = "not-a-plugin";
  constructor(readonly directory: string) {
    super(`no Cargo.toml or build.zig found in ${directory}`);
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
