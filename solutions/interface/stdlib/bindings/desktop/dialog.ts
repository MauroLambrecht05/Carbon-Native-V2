// dialog — the OS's own file pickers and message boxes.

declare const __cm_dialog_open_file: (optsJson: string) => string | null;
declare const __cm_dialog_open_files: (optsJson: string) => string[];
declare const __cm_dialog_open_dir: (optsJson: string) => string | null;
declare const __cm_dialog_save_file: (optsJson: string) => string | null;
declare const __cm_dialog_message: (title: string, body: string, level: string) => void;
declare const __cm_dialog_confirm: (title: string, body: string) => boolean;

export interface FileFilter {
  name: string;
  extensions: string[];
}
export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export const dialog = {
  openFile: (opts: OpenDialogOptions = {}): string | null =>
    __cm_dialog_open_file(JSON.stringify(opts)),
  openFiles: (opts: OpenDialogOptions = {}): string[] =>
    __cm_dialog_open_files(JSON.stringify(opts)),
  openDir: (opts: OpenDialogOptions = {}): string | null =>
    __cm_dialog_open_dir(JSON.stringify(opts)),
  saveFile: (opts: OpenDialogOptions = {}): string | null =>
    __cm_dialog_save_file(JSON.stringify(opts)),
  message: (title: string, body: string, level: "info" | "warning" | "error" = "info"): void =>
    __cm_dialog_message(title, body, level),
  confirm: (title: string, body: string): boolean => __cm_dialog_confirm(title, body),
};
