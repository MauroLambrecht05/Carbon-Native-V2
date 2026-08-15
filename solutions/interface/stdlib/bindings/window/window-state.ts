// window state — the size, position and whatever else the app wants to
// remember between runs, scoped to a file in the OS config dir.

declare const __cm_window_state_set_app_name: (name: string) => void;
declare const __cm_window_state_save: (json: string) => void;
declare const __cm_window_state_load: () => string | null;
declare const __cm_window_state_clear: () => void;

export const windowState = {
  /** Override the app name used to scope the state file (defaults to exe stem). */
  setAppName: (name: string): void => __cm_window_state_set_app_name(name),
  /** Save arbitrary JSON-serializable state. Persists in the OS config dir. */
  save: (state: unknown): void => __cm_window_state_save(JSON.stringify(state)),
  /** Returns the saved state, or null if nothing has been persisted yet. */
  load: <T = unknown>(): T | null => {
    const raw = __cm_window_state_load();
    if (raw == null) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  },
  clear: (): void => __cm_window_state_clear(),
};
