// The installer formats carbon can produce.
//
// One registry, because this list was previously written out five times inside
// `carbon bundle` alone — the `--target all` expansion, the validation list,
// two help strings and a switch — and the packaging capability, which actually
// owns the generators, declared it nowhere. A format added to the switch but
// missed in the validation list is silently unreachable; that is the failure
// this prevents.

export type InstallerTargetId = "nsis" | "wix" | "dmg" | "appimage" | "deb";

/** The OS an installer can be produced on. */
export type TargetPlatform = "win32" | "darwin" | "linux";

export interface InstallerTarget {
  readonly id: InstallerTargetId;
  /** One line, shown in `carbon bundle --help`. */
  readonly summary: string;
  /**
   * Where this installer can be built.
   *
   * Not where it runs — where the toolchain that produces it exists. A DMG
   * needs macOS tooling, so `--target dmg` on Linux is a refusal rather than a
   * silent no-op.
   */
  readonly platform: TargetPlatform;
  /**
   * Included by `--target all`.
   *
   * `all` means "everything applicable on this machine", so a target is in it
   * only when its platform matches the host.
   */
  readonly inAll: boolean;
}

export const INSTALLER_TARGETS: readonly InstallerTarget[] = [
  { id: "nsis", summary: "Windows NSIS installer", platform: "win32", inAll: true },
  // WiX produces an MSI, which is the enterprise-deployment format. It is
  // excluded from `all` because it needs the WiX toolset installed separately
  // and most projects want the NSIS installer.
  { id: "wix", summary: "Windows WiX MSI installer", platform: "win32", inAll: false },
  { id: "dmg", summary: "macOS DMG installer", platform: "darwin", inAll: true },
  { id: "appimage", summary: "Linux AppImage package", platform: "linux", inAll: true },
  { id: "deb", summary: "Linux DEB package", platform: "linux", inAll: true },
];

export const INSTALLER_TARGET_IDS: readonly InstallerTargetId[] = INSTALLER_TARGETS.map(
  (t) => t.id,
);

export function installerTarget(id: string): InstallerTarget | undefined {
  return INSTALLER_TARGETS.find((t) => t.id === id);
}

/**
 * What `--target all` expands to on a given platform.
 *
 * Defaults to the host, which is the only place a build can actually run.
 */
export function targetsForPlatform(
  platform: NodeJS.Platform = process.platform,
): InstallerTarget[] {
  return INSTALLER_TARGETS.filter((t) => t.inAll && t.platform === platform);
}

/**
 * Whether a target can be built on this platform.
 *
 * Worth its own function because the check was previously written inline and
 * got it wrong: `carbon bundle --target dmg` normalised `darwin` to `macos` in
 * one place and compared against `"darwin"` in another, so the DMG branch was
 * unreachable on every machine.
 */
export function isBuildableOn(
  target: InstallerTarget,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return target.platform === platform;
}
