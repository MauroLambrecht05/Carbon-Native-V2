// File-system port. Direct calls to `__cm_fs_*` host imports — no
// invoke channel, no serialisation overhead. Operations are synchronous
// at the engine boundary but exposed as `Promise<T>` here so callers
// can `await` consistently with the rest of @carbon/api.
//
//   import * as fs from "@carbon/api/fs";
//   const text = await fs.readText("./README.md");
//   await fs.writeText("./out.log", text);

import "../host/imports";

export interface DirEntry {
  /** Just the filename, not the full path. */
  name: string;
  /** Equal to `path.join(parent, name)`. */
  path: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  /** Unix-epoch ms; null when the OS doesn't expose it. */
  modified: number | null;
  created: number | null;
}

export async function readText(path: string): Promise<string> {
  return __cm_fs_read_text(path);
}

export async function writeText(path: string, content: string): Promise<void> {
  __cm_fs_write_text(path, content);
}

export async function exists(path: string): Promise<boolean> {
  return __cm_fs_exists(path);
}

export async function isFile(path: string): Promise<boolean> {
  return __cm_fs_is_file(path);
}

export async function isDirectory(path: string): Promise<boolean> {
  return __cm_fs_is_dir(path);
}

/** List a directory. Returns an array of `DirEntry` objects with the
 *  full path resolved. The engine returns just names; we synthesise
 *  the `path` field by joining with `/` (callers that want OS separators
 *  should re-join via @carbon/api/path or path-browserify). */
export async function readDir(dirPath: string): Promise<DirEntry[]> {
  const names = __cm_fs_read_dir(dirPath);
  const out: DirEntry[] = [];
  const sep = dirPath.includes("\\") && !dirPath.includes("/") ? "\\" : "/";
  for (const name of names) {
    const full = `${dirPath.replace(/[/\\]+$/, "")}${sep}${name}`;
    out.push({
      name,
      path: full,
      isFile: __cm_fs_is_file(full),
      isDirectory: __cm_fs_is_dir(full),
    });
  }
  return out;
}

/** Create a directory. `recursive: true` creates parents (mkdir -p). */
export async function mkdir(path: string, recursive = true): Promise<void> {
  __cm_fs_mkdir(path, recursive);
}

/** Remove a file or directory. `recursive: true` deletes a directory
 *  and its contents (rm -rf). */
export async function remove(path: string, recursive = false): Promise<void> {
  __cm_fs_rm(path, recursive);
}

export async function rename(from: string, to: string): Promise<void> {
  __cm_fs_rename(from, to);
}

export async function stat(path: string): Promise<FileStat> {
  return JSON.parse(__cm_fs_stat(path)) as FileStat;
}

// ─── App-defined fs commands ─────────────────────────────────────────────
// terax-ai's upstream uses `invoke("fs_create_file" | "fs_write_file" |
// "fs_rename" | "fs_delete")` for higher-level operations the engine
// registers. We expose them as named functions so callers don't have
// to spell out command names.

import { invoke } from "../bridge/invoke.ts";

export async function createFile(path: string): Promise<void> {
  await invoke("fs_create_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  await invoke("fs_write_file", { path, content });
}

export async function renameFile(from: string, to: string): Promise<void> {
  await invoke("fs_rename", { from, to });
}

export async function deleteFile(path: string): Promise<void> {
  await invoke("fs_delete", { path });
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("fs_read_file", { path });
}

export async function readDirEntries(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("fs_read_dir", { path });
}
