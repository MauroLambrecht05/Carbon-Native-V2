// @carbon/plugins/instance — a single-instance lock, keyed by the app's
// own name (Windows only for now — see the instance plugin's own main.zig
// header comment).
//
// import { useSingleInstance } from "@carbon/plugins/instance";
// useSingleInstance(); // call once, high in the app
//
// If another instance of this app is already running, the native call
// exits THIS process directly — there is no "already running" branch to
// handle in JS, by construction (see the plugin's own main.zig header for
// the full reasoning). When this hook's effect runs at all, this is
// already guaranteed to be the sole instance.

import { useEffect } from "react";
import { acquire as rawAcquire } from "carbon:instance";
import { awaitPluginReady, pluginGlobalReady } from "./_awaitPluginReady.ts";

function pluginReady(): boolean {
  return pluginGlobalReady("acquire");
}

export function useSingleInstance(): void {
  useEffect(() => {
    return awaitPluginReady(pluginReady, () => {
      rawAcquire();
      // No cleanup: the lock is held for the whole process lifetime by
      // design (see instance_acquire's own doc comment in
      // carbon_plugin.h) — there is no "release" call to make on unmount.
    });
  }, []);
}
