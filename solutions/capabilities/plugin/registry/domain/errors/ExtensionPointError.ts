// Why this capability refuses.
//
// One base class the CLI can catch, so a malformed registry is reported as a
// message and anything else surfaces with its stack. Same split the plugins
// capability uses.

export class ExtensionPointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The Zig registry could not be read as a registry. */
export class RegistryParseError extends ExtensionPointError {
  constructor(
    message: string,
    /** 1-indexed line in extension-points.zig, when we know it. */
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
  }
}

/** The registry parsed, but says something that cannot be true. */
export class RegistryInvariantError extends ExtensionPointError {}

/** A checked-in generated artifact no longer matches the registry. */
export class GeneratedArtifactStaleError extends ExtensionPointError {
  constructor(readonly stale: readonly string[]) {
    super(
      `${stale.length} generated artifact(s) are out of date with the registry:\n` +
        stale.map((p) => `  ${p}`).join("\n") +
        "\n\nRegenerate them:  carbon ext generate",
    );
  }
}

/** A plugin manifest names a point the registry does not define. */
export class UnknownExtensionPointError extends ExtensionPointError {
  constructor(readonly id: string, known: readonly string[]) {
    super(
      `no extension point "${id}".\n` +
        `  known points: ${known.join(", ")}`,
    );
  }
}
