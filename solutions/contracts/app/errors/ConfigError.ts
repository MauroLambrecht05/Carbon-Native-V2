// Raised when a carbon.toml is missing, unparseable, or violates the manifest
// rules. Carries the file path so the message can point at it.

export class ConfigError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ConfigError";
  }
}
