// OS metadata. Each property is fetched lazily on access — the underlying
// host imports are cheap (no syscalls; values resolve from cached
// constants populated at engine startup).

import "../host/imports";

export type Platform = "windows" | "macos" | "linux" | "ios" | "android" | "unknown";
export type Family = "unix" | "windows" | "unknown";
export type Arch = "x86_64" | "aarch64" | "x86" | "arm" | "unknown";

/** Normalised platform name (lowercase). */
export function platform(): Platform {
  return __cm_os_platform() as Platform;
}

/** Platform family — useful when the difference between macOS and Linux
 *  doesn't matter (both unix). */
export function family(): Family {
  return __cm_os_family() as Family;
}

/** CPU architecture. */
export function arch(): Arch {
  return __cm_os_arch() as Arch;
}

/** OS-reported version string. Format varies by platform — Windows gives
 *  "10.0.22000.493", macOS "14.4.1", Linux kernel "6.5.0-15-generic". */
export function version(): string {
  return __cm_os_version();
}

/** BCP-47 locale tag — "en-US", "fr-FR", "ja-JP". Returns null if the
 *  OS doesn't expose one. */
export function locale(): string | null {
  return __cm_os_locale();
}

/** Hostname (machine name). */
export function hostname(): string {
  return __cm_os_hostname();
}

/** "\n" on unix, "\r\n" on Windows. */
export function eol(): string {
  return __cm_os_eol();
}

/** Current executable's absolute path. */
export function exePath(): string {
  return __cm_os_exe_path();
}

/** "light" | "dark" — system preference. */
export function theme(): "light" | "dark" {
  return __cm_os_theme() === "dark" ? "dark" : "light";
}
