// "Launch this app at OS login" — backed by `auto-launch` on the engine
// side (Win32 registry / launchd / XDG autostart entry).
//
// `setName` and `setArgs` are sticky settings the engine uses next time
// `enable()` is called; ports of Tauri's plugin-autostart usually leave
// them at defaults (app name + no extra args).

import "./hosts";

export async function setName(name: string): Promise<void> {
  __cm_autostart_set_name(name);
}

export async function setArgs(args: string[]): Promise<void> {
  __cm_autostart_set_args(JSON.stringify(args));
}

export async function enable(): Promise<void> {
  __cm_autostart_enable();
}

export async function disable(): Promise<void> {
  __cm_autostart_disable();
}

export async function isEnabled(): Promise<boolean> {
  return __cm_autostart_is_enabled();
}
