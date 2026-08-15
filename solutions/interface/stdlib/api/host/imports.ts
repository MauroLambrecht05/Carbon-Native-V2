// Shared `declare const` block for the engine's __cm_* host imports.
//
// Every @carbon/api subpath module needs to call a handful of these, and
// declaring them locally per-module gets repetitive. We re-export the
// types here (and rely on globalThis-side lookup at runtime); subpaths
// `import type { ... } from "../host/imports";` for TS narrowing without pulling
// runtime weight, since these are zero-cost ambient globals at runtime.
//
// New host imports added in the engine should be added here AND
// declared on `globalThis` via the same name — keeps the typing
// surface honest as the runtime API evolves.

// ─── App ──────────────────────────────────────────────────────────────────
declare global {
  const __cm_app_name: () => string;
  const __cm_app_version: () => string;

  // ─── Window ─────────────────────────────────────────────────────────────
  const __cm_window_show: () => void;
  const __cm_window_hide: () => void;
  const __cm_window_minimize: () => void;
  const __cm_window_maximize: () => void;
  const __cm_window_unmaximize: () => void;
  const __cm_window_toggle_maximize: () => void;
  const __cm_window_close: () => void;
  const __cm_window_focus: () => void;
  const __cm_window_set_title: (title: string) => void;
  const __cm_window_set_fullscreen: (on: boolean) => void;
  const __cm_window_start_drag: () => void;
  const __cm_window_is_maximized: () => boolean;
  const __cm_window_is_minimized: () => boolean;
  const __cm_window_is_focused: () => boolean;
  const __cm_window_resize_tick: () => number;
  const __cm_window_inner_width: () => number;
  const __cm_window_inner_height: () => number;
  const __cm_window_device_pixel_ratio: () => number;

  // ─── File system (typed wrappers — direct host imports, no invoke) ─────
  const __cm_fs_read_text: (path: string) => string;
  const __cm_fs_write_text: (path: string, content: string) => void;
  const __cm_fs_exists: (path: string) => boolean;
  const __cm_fs_is_file: (path: string) => boolean;
  const __cm_fs_is_dir: (path: string) => boolean;
  const __cm_fs_read_dir: (path: string) => string[];
  const __cm_fs_mkdir: (path: string, recursive: boolean) => void;
  const __cm_fs_rm: (path: string, recursive: boolean) => void;
  const __cm_fs_rename: (from: string, to: string) => void;
  const __cm_fs_stat: (path: string) => string;
  const __cm_fs_home_dir: () => string | null;
  const __cm_fs_app_data_dir: () => string | null;
  const __cm_fs_app_config_dir: () => string | null;
  const __cm_fs_app_cache_dir: () => string | null;
  const __cm_fs_temp_dir: () => string;

  // ─── Shell / opener ────────────────────────────────────────────────────
  const __cm_shell_open: (target: string) => void;
  const __cm_shell_resolve: (cmd: string) => string | null;
  const __cm_shell_reveal: (path: string) => void;

  // ─── OS info ───────────────────────────────────────────────────────────
  const __cm_os_arch: () => string;
  const __cm_os_eol: () => string;
  const __cm_os_exe_path: () => string;
  const __cm_os_family: () => string;
  const __cm_os_home_dir: () => string;
  const __cm_os_hostname: () => string;
  const __cm_os_locale: () => string | null;
  const __cm_os_platform: () => string;
  const __cm_os_temp_dir: () => string;
  const __cm_os_theme: () => string;
  const __cm_os_version: () => string;

  // ─── PTY ───────────────────────────────────────────────────────────────
  const __cm_pty_spawn: (specJson: string) => number;
  const __cm_pty_write: (id: number, data: string) => void;
  const __cm_pty_read: (id: number) => string;
  const __cm_pty_resize: (id: number, cols: number, rows: number) => void;
  const __cm_pty_close: (id: number) => void;
  const __cm_pty_kill: (id: number) => void;
  const __cm_pty_wait: (id: number) => number;

  // ─── Process ───────────────────────────────────────────────────────────
  const __cm_proc_pid_self: () => number;
  const __cm_proc_relaunch_self: () => void;

  // ─── Autostart ─────────────────────────────────────────────────────────
  const __cm_autostart_set_name: (name: string) => void;
  const __cm_autostart_set_args: (argsJson: string) => void;
  const __cm_autostart_enable: () => void;
  const __cm_autostart_disable: () => void;
  const __cm_autostart_is_enabled: () => boolean;

  // ─── Invoke channel ────────────────────────────────────────────────────
  const __cm_invoke: (name: string, argsJson: string) => string;
  const __cm_invoke_has: (name: string) => boolean;

  // ─── Multi-window (process-per-window v1) ──────────────────────────────
  const __cm_window_label: () => string;
  const __cm_window_opts_json: () => string;
  const __cm_window_open: (label: string, optsJson: string) => void;
}

export {};
