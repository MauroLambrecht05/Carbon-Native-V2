// Standard directories. Engine maps to OS-native locations:
//   - homeDir:      $HOME on unix, %USERPROFILE% on Windows
//   - appDataDir:   $XDG_DATA_HOME/<app> / ~/Library/Application Support/<app> / %LOCALAPPDATA%\<app>
//   - appConfigDir: $XDG_CONFIG_HOME/<app> / ~/Library/Preferences/<app> / %APPDATA%\<app>
//   - appCacheDir:  $XDG_CACHE_HOME/<app> / ~/Library/Caches/<app> / %LOCALAPPDATA%\<app>\Cache
//   - tempDir:      $TMPDIR / /tmp / %TEMP%
//
// All paths come back with the OS-native separator (no normalisation —
// callers that want forward-slash-only should `.replace(/\\/g, "/")`).

import "../host/imports";

export async function homeDir(): Promise<string> {
  const v = __cm_fs_home_dir();
  if (!v) throw new Error("home directory not available");
  return v;
}

export async function appDataDir(): Promise<string> {
  const v = __cm_fs_app_data_dir();
  if (!v) throw new Error("app data dir not available");
  return v;
}

export async function appConfigDir(): Promise<string> {
  const v = __cm_fs_app_config_dir();
  if (!v) throw new Error("app config dir not available");
  return v;
}

export async function appCacheDir(): Promise<string> {
  const v = __cm_fs_app_cache_dir();
  if (!v) throw new Error("app cache dir not available");
  return v;
}

export async function tempDir(): Promise<string> {
  return __cm_fs_temp_dir();
}
