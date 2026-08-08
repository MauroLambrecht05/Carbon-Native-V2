// Hand things off to the OS — open a URL in the default browser, reveal
// a file in the OS file manager. Backed by the `opener` crate on the
// engine side (Win32 ShellExecute / macOS NSWorkspace / Linux xdg-open).
//
//   await openUrl("https://example.com");
//   await revealInFinder("C:/Users/me/notes.txt");

import "./hosts";

/** Open a URL or file path with the OS-default handler. */
export async function openUrl(url: string): Promise<void> {
  __cm_shell_open(url);
}

/** Reveal a file or directory in the OS file manager (Finder / Explorer /
 *  Files). Selects the item if possible, otherwise opens the containing
 *  directory. */
export async function revealInFinder(path: string): Promise<void> {
  __cm_shell_reveal(path);
}

/** Find an executable on PATH. Returns the absolute path, or null if
 *  not found. Useful for "which git" / "where node" style probes. */
export async function resolve(cmd: string): Promise<string | null> {
  return __cm_shell_resolve(cmd);
}
