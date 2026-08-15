// fs — the filesystem host imports.
//
// Synchronous on purpose: every method blocks on the OS call.

declare const __cm_fs_read_text: (path: string) => string;
declare const __cm_fs_write_text: (path: string, content: string) => void;
declare const __cm_fs_exists: (path: string) => boolean;
declare const __cm_fs_is_file: (path: string) => boolean;
declare const __cm_fs_is_dir: (path: string) => boolean;
declare const __cm_fs_read_dir: (path: string) => string[];
declare const __cm_fs_mkdir: (path: string, recursive: boolean) => void;
declare const __cm_fs_rm: (path: string, recursive: boolean) => void;
declare const __cm_fs_rename: (from: string, to: string) => void;
declare const __cm_fs_stat: (path: string) => string;
declare const __cm_fs_home_dir: () => string | null;
declare const __cm_fs_app_data_dir: () => string | null;
declare const __cm_fs_app_config_dir: () => string | null;
declare const __cm_fs_app_cache_dir: () => string | null;
declare const __cm_fs_temp_dir: () => string;

export interface FileStat {
  size: number;
  modifiedMs: number;
  isFile: boolean;
  isDir: boolean;
}

export const fs = {
  readText: (path: string): string => __cm_fs_read_text(path),
  writeText: (path: string, content: string): void => __cm_fs_write_text(path, content),
  exists: (path: string): boolean => __cm_fs_exists(path),
  isFile: (path: string): boolean => __cm_fs_is_file(path),
  isDir: (path: string): boolean => __cm_fs_is_dir(path),
  readDir: (path: string): string[] => __cm_fs_read_dir(path),
  mkdir: (path: string, recursive = true): void => __cm_fs_mkdir(path, recursive),
  rm: (path: string, recursive = false): void => __cm_fs_rm(path, recursive),
  rename: (from: string, to: string): void => __cm_fs_rename(from, to),
  stat: (path: string): FileStat => JSON.parse(__cm_fs_stat(path)),
  homeDir: (): string | null => __cm_fs_home_dir(),
  appDataDir: (): string | null => __cm_fs_app_data_dir(),
  appConfigDir: (): string | null => __cm_fs_app_config_dir(),
  appCacheDir: (): string | null => __cm_fs_app_cache_dir(),
  tempDir: (): string => __cm_fs_temp_dir(),
};
