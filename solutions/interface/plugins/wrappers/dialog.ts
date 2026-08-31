// @carbon/plugins/dialog — the OS's own file pickers and message boxes.
//
// import { useDialog } from "@carbon/plugins/dialog";
// const { openFile, confirm } = useDialog();
// const path = openFile({ filters: [{ name: "Images", extensions: ["png"] }] });
//
// No requestAnimationFrame-deferral needed — see clipboard.ts's module doc
// comment for why (only ever called from an event handler, well after
// plugin registration has already happened).

import { useCallback } from "react";
import {
  openFile as rawOpenFile,
  openFiles as rawOpenFiles,
  openDir as rawOpenDir,
  saveFile as rawSaveFile,
  openFileText as rawOpenFileText,
  saveFileText as rawSaveFileText,
  message as rawMessage,
  confirm as rawConfirm,
} from "carbon:dialog";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface UseDialogResult {
  openFile: (opts?: OpenDialogOptions) => string | null;
  openFiles: (opts?: OpenDialogOptions) => string[];
  openDir: (opts?: OpenDialogOptions) => string | null;
  saveFile: (opts?: OpenDialogOptions) => string | null;
  /** Shows the picker and returns the chosen file's content directly — no
   * raw filesystem path ever reaches this call site. */
  openFileText: (opts?: OpenDialogOptions) => string | null;
  /** Shows the picker and writes `content` to wherever the user chose.
   * Returns false if the user cancelled. */
  saveFileText: (content: string, opts?: OpenDialogOptions) => boolean;
  message: (title: string, body: string, level?: "info" | "warning" | "error") => void;
  confirm: (title: string, body: string) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return typeof (globalThis as unknown as { confirm?: unknown }).confirm === "function";
}

export function useDialog(): UseDialogResult {
  const openFile = useCallback(
    (opts: OpenDialogOptions = {}): string | null => (pluginReady() ? rawOpenFile(opts) : null),
    [],
  );
  const openFiles = useCallback(
    (opts: OpenDialogOptions = {}): string[] => (pluginReady() ? rawOpenFiles(opts) : []),
    [],
  );
  const openDir = useCallback(
    (opts: OpenDialogOptions = {}): string | null => (pluginReady() ? rawOpenDir(opts) : null),
    [],
  );
  const saveFile = useCallback(
    (opts: OpenDialogOptions = {}): string | null => (pluginReady() ? rawSaveFile(opts) : null),
    [],
  );
  const openFileText = useCallback(
    (opts: OpenDialogOptions = {}): string | null => (pluginReady() ? rawOpenFileText(opts) : null),
    [],
  );
  const saveFileText = useCallback(
    (content: string, opts: OpenDialogOptions = {}): boolean =>
      pluginReady() ? rawSaveFileText(content, opts) : false,
    [],
  );
  const message = useCallback(
    (title: string, body: string, level: "info" | "warning" | "error" = "info"): void => {
      if (pluginReady()) rawMessage(title, body, level);
    },
    [],
  );
  const confirm = useCallback(
    (title: string, body: string): boolean => (pluginReady() ? rawConfirm(title, body) : false),
    [],
  );

  return { openFile, openFiles, openDir, saveFile, openFileText, saveFileText, message, confirm, ready: pluginReady() };
}
