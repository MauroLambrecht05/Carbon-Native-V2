// Why scaffolding refused.
//
// Typed rather than bare Error strings because the caller has to distinguish
// them: an unknown preset is a usage error the CLI answers by listing
// presets, a non-empty target is a user error. Both used to be `log.error`
// plus `return 1` inside the command, which meant no other caller could tell
// them apart.
//
// A target outside the workspace used to be a third case here
// (OutsideWorkspaceError) back when the generated package.json pinned
// `file:` dependencies into the workspace's packages/ directory. Nothing
// generated depends on that anymore — see PackagesPath's workspacePathFrom —
// so it is no longer a refusal at all.

export abstract class ScaffoldError extends Error {
  abstract readonly kind: string;
}

export class UnknownPresetError extends ScaffoldError {
  readonly kind = "unknown-preset";

  constructor(readonly requested: string, readonly available: readonly string[]) {
    super(
      `Unknown preset "${requested}". Run 'carbon init --list-presets' to see options.`,
    );
  }
}

export class TargetNotEmptyError extends ScaffoldError {
  readonly kind = "target-not-empty";

  constructor(readonly target: string) {
    super(`${target} exists and is not empty (use --here only on empty dirs)`);
  }
}
