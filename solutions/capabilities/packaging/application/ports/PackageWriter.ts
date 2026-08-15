// Writing the generated definition, and — since BuildPackageUseCase — the
// package tree it gets materialized into.
//
// Behind a port so the use case is testable: the integration tests drive
// GeneratePackageUseCase and BuildPackageUseCase with an in-memory writer and
// assert on the file contents, which is not possible against `node:fs`
// directly.

export interface PackageWriter {
  writeFile(path: string, contents: string): void;
  createDirectory(path: string): void;
  /** Copies a file into place — the built binary, into a package tree. */
  copyFile(from: string, to: string): void;
  /** Marks a file executable (POSIX mode 755) — maintainer scripts, launchers. */
  makeExecutable(path: string): void;
}
