// Writing the generated definition.
//
// Behind a port so the use case is testable: the integration tests drive
// GeneratePackageUseCase with an in-memory writer and assert on the file
// contents, which is not possible against `node:fs` directly.

export interface PackageWriter {
  writeFile(path: string, contents: string): void;
  createDirectory(path: string): void;
}
