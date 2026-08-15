// os — what machine this is.

declare const __cm_os_platform: () => string;
declare const __cm_os_arch: () => string;
declare const __cm_os_version: () => string;
declare const __cm_os_hostname: () => string;
declare const __cm_os_temp_dir: () => string;
declare const __cm_os_home_dir: () => string;
declare const __cm_os_locale: () => string;
declare const __cm_os_eol: () => string;
declare const __cm_os_exe_path: () => string;
declare const __cm_os_family: () => string;

export const os = {
  /** "windows" | "macos" | "linux" | "android" | "ios" | "unknown". */
  platform: (): string => __cm_os_platform(),
  /** "x86_64" | "aarch64" | "x86" | "arm" | "unknown". */
  arch: (): string => __cm_os_arch(),
  /** A coarse identifier; apps that need exact kernel version should
   *  shell out via process.exec. */
  version: (): string => __cm_os_version(),
  hostname: (): string => __cm_os_hostname(),
  tempDir: (): string => __cm_os_temp_dir(),
  homeDir: (): string => __cm_os_home_dir(),
  locale: (): string => __cm_os_locale(),
  /** "\r\n" on Windows, "\n" elsewhere. */
  eol: (): string => __cm_os_eol(),
  exePath: (): string => __cm_os_exe_path(),
  /** "windows" | "unix" | "unknown". */
  family: (): string => __cm_os_family(),
};
