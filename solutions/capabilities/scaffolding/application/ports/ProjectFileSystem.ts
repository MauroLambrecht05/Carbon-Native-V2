// The filesystem, as scaffolding needs it.
//
// Four operations, not a general filesystem abstraction. Narrow on purpose: it
// is the whole surface the use case is allowed to touch, so "what can
// scaffolding do to a disk" is answerable by reading this file.

export interface ProjectFileSystem {
  /**
   * True when the path does not exist, or exists and contains nothing.
   *
   * A path that exists but cannot be read counts as NOT empty — refusing to
   * scaffold into a directory we cannot inspect is the safe direction.
   */
  isEmptyDirectory(path: string): boolean;

  createDirectory(path: string): void;

  /** Writes the file, creating parent directories as needed. */
  writeFile(path: string, contents: string): void;
}
