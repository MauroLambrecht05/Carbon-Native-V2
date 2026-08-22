// Why scaffolding refused.
//
// Typed rather than bare Error strings because the caller has to distinguish
// them: an unknown preset is a usage error the CLI answers by listing presets,
// a non-empty target is a user error, and being outside the workspace is a
// known limitation with its own explanation. All three used to be `log.error`
// plus `return 1` inside the command, which meant no other caller could tell
// them apart.

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

/**
 * The generated package.json points at the workspace's packages/ directory with
 * `file:` dependencies, so a project scaffolded outside the workspace cannot
 * resolve the runtime. See PackagesPath for the whole story.
 */
export class OutsideWorkspaceError extends ScaffoldError {
  readonly kind = "outside-workspace";

  constructor(readonly target: string, readonly root: string, detail: string) {
    super(
      `${detail}\nFor now, run \`carbon init\` inside the carbon-native workspace ` +
        `(somewhere under ${root}). npm-published packages aren't ready yet.`,
    );
  }
}
