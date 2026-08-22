// Where the registry is read from and the renderings are written to.
//
// Behind a port because the two use cases differ only in what they do with a
// rendering — generate writes it, check compares it — and both need to be
// exercisable against a store with no disk behind it. The integration tests
// drive the whole pipeline through an in-memory implementation.

export interface ArtifactStore {
  /** The registry source. Throws if it is not there — that is not a warning. */
  readRegistry(): string;

  /**
   * A previously generated artifact, or null when it has never been written.
   *
   * Null is a normal answer: a fresh checkout of a branch that adds a point
   * has a registry and no rendering of it yet, and `check` should say
   * "missing" rather than "differs from an empty file".
   */
  readArtifact(relativePath: string): string | null;

  writeArtifact(relativePath: string, contents: string): void;
}
