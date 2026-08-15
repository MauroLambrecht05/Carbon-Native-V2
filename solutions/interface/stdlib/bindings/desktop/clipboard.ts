// clipboard — the system clipboard, text only.

declare const __cm_clipboard_read_text: () => string;
declare const __cm_clipboard_write_text: (text: string) => void;
declare const __cm_clipboard_clear: () => void;

export const clipboard = {
  readText: (): string => __cm_clipboard_read_text(),
  writeText: (text: string): void => __cm_clipboard_write_text(text),
  clear: (): void => __cm_clipboard_clear(),
};
