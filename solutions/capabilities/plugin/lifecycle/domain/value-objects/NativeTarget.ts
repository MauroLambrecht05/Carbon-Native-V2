// Native target directory names — canonical table, quoted verbatim from
// solutions/contracts/plugin/README.md ("Native target directory names").
// carbon/build.zig's own copy and plugin_loader.rs's must agree with this
// exactly; all three resolve carbon/native/<os>/<arch>/<name>.<ext>.

export type NativeOs = "windows" | "linux" | "macos";

export function hostOsName(): NativeOs {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    default:
      throw new Error(`carbon: unsupported host OS "${process.platform}" for plugin staging`);
  }
}

export function hostArchName(): string {
  const os = hostOsName();
  switch (process.arch) {
    case "x64":
      return "x86_64";
    // Zig's own identifier is aarch64 on every OS; ours matches Apple's
    // convention on macOS specifically (see the README table).
    case "arm64":
      return os === "macos" ? "arm64" : "aarch64";
    default:
      throw new Error(`carbon: unsupported host architecture "${process.arch}" for plugin staging`);
  }
}

export function hostExt(): string {
  switch (hostOsName()) {
    case "windows":
      return "dll";
    case "linux":
      return "so";
    case "macos":
      return "dylib";
  }
}
