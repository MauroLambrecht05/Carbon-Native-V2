// shell — handing a path or URL to whatever the OS says owns it.

declare const __cm_shell_open: (target: string) => void;
declare const __cm_shell_reveal: (path: string) => void;
declare const __cm_shell_resolve: (path: string) => string | null;

export const shell = {
  /** Opens URL or file path in the OS-default handler. */
  open: (target: string): void => __cm_shell_open(target),
  /** Highlights the file in the OS file manager (Explorer / Finder / nautilus). */
  reveal: (path: string): void => __cm_shell_reveal(path),
  /** Canonicalize a path. Returns null if it can't resolve. */
  resolve: (path: string): string | null => __cm_shell_resolve(path),
};
