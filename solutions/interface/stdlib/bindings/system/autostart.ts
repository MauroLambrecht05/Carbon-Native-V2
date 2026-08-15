// autostart — registering the app to launch at login.

declare const __cm_autostart_set_name: (name: string) => void;
declare const __cm_autostart_set_args: (argsJson: string) => void;
declare const __cm_autostart_enable: () => void;
declare const __cm_autostart_disable: () => void;
declare const __cm_autostart_is_enabled: () => boolean;

export const autostart = {
  /** Override the autostart entry name (defaults to the binary's file stem). */
  setName: (name: string): void => __cm_autostart_set_name(name),
  setArgs: (args: string[]): void => __cm_autostart_set_args(JSON.stringify(args)),
  enable: (): void => __cm_autostart_enable(),
  disable: (): void => __cm_autostart_disable(),
  isEnabled: (): boolean => __cm_autostart_is_enabled(),
};
