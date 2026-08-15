export class BuildNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no build "${id}"`);
  }
}
