// @carbon/plugins/global-shortcuts — a system-wide (OS-level) keyboard
// shortcut that fires even when the app is unfocused or minimized.
//
// import { useGlobalShortcut } from "@carbon/plugins/global-shortcuts";
// useGlobalShortcut("Ctrl+Alt+P", () => console.log("summoned"));
//
// `accelerator` syntax: `+`-separated, modifiers (Ctrl/Control, Alt/Option,
// Shift, Super/Cmd/Command — case-insensitive) followed by one key name
// (e.g. "P", "F1", "Digit1") — see the `global-hotkey` Rust crate this
// plugin's native side is built on for the full grammar.
//
// UNLIKE clipboard/dialog/notification/keychain/fonts, this genuinely
// needs `useEffect`: registering a global shortcut is a subscription with
// a lifecycle (register on mount, unregister on unmount/accelerator
// change), not a value fetched synchronously — the exact case `useEffect`
// exists for. This isn't in tension with fonts' hook avoiding an effect —
// that one avoided a SECOND, setState-chained effect used only to defer a
// value-fetch past first render (proven unreliable in this runtime); a
// single, ordinary mount/cleanup effect with a stable dependency array
// does not have that problem in general — but see _awaitPluginReady.ts
// for a case where it still does: this plugin's own globals are not
// guaranteed to exist yet on a cold launch, despite what the paragraph
// above assumed (confirmed via a live tray reproduction, same underlying
// runtime-ordering fact — the code below now accounts for it).

import { useEffect, useRef } from "react";
import { register as rawRegister, unregister as rawUnregister } from "carbon:global-shortcuts";
import { awaitPluginReady, pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseGlobalShortcutResult {
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("globalShortcutRegister");
}

export function useGlobalShortcut(accelerator: string, callback: () => void): UseGlobalShortcutResult {
  // A ref, not a `callback` dependency: re-subscribing on every render a
  // caller passes a new (non-memoized) callback would mean registering/
  // unregistering the OS-level shortcut constantly. The ref always reads
  // the latest callback without that.
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    return awaitPluginReady(pluginReady, () => {
      const id = rawRegister(accelerator);
      if (id == null) return;

      const carbon = (globalThis as unknown as { carbon?: { on: Function; off: Function } }).carbon;
      if (!carbon) return;

      const listener = (payload: { id: number } | null) => {
        if (payload?.id === id) callbackRef.current();
      };
      carbon.on("global-shortcut.fired", listener);

      return () => {
        carbon.off("global-shortcut.fired", listener);
        rawUnregister(accelerator);
      };
    });
  }, [accelerator]);

  return { ready: pluginReady() };
}
