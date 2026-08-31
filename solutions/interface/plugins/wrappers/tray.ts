// @carbon/plugins/tray — a system tray icon, with an optional context menu.
//
// import { useTray } from "@carbon/plugins/tray";
// useTray(
//   { icon: "assets/tray.png", tooltip: "My App", menu: [{ id: "quit", label: "Quit" }] },
//   { onClick: () => console.log("clicked"), onMenuSelect: (id) => console.log("menu:", id) },
// );
//
// One tray icon per process — call this once, high in the app, not per
// component. Like global-shortcuts, this needs `useEffect`: it's a
// subscription (listen for click/menu-select events) with a lifecycle, not
// a value fetched synchronously.

import { useEffect, useRef } from "react";
import { setup as rawSetup } from "carbon:tray";
import { awaitPluginReady, pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface TrayMenuItem {
  id: string;
  label: string;
}

export interface TrayOptions {
  /** A PNG file, resolved relative to the project directory unless absolute. */
  icon: string;
  tooltip?: string;
  menu?: TrayMenuItem[];
}

export interface TrayCallbacks {
  onClick?: () => void;
  onMenuSelect?: (id: string) => void;
}

export interface UseTrayResult {
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("setup");
}

export function useTray(options: TrayOptions, callbacks: TrayCallbacks = {}): UseTrayResult {
  const { icon, tooltip, menu } = options;

  // Refs, not `callbacks` in the dependency array — a caller passing a
  // fresh `{ onClick, onMenuSelect }` object every render (the natural
  // way to call this hook) shouldn't tear down and recreate the tray's
  // event listeners each time.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    return awaitPluginReady(pluginReady, () => {
      rawSetup({ icon, tooltip, menu });

      const carbon = (globalThis as unknown as { carbon?: { on: Function; off: Function } }).carbon;
      if (!carbon) return;

      const clickListener = () => callbacksRef.current.onClick?.();
      const menuListener = (payload: { id: string } | null) => {
        if (payload?.id) callbacksRef.current.onMenuSelect?.(payload.id);
      };
      carbon.on("tray.click", clickListener);
      carbon.on("tray.menu", menuListener);

      return () => {
        carbon.off("tray.click", clickListener);
        carbon.off("tray.menu", menuListener);
        // No teardown call to the native side — a process has at most one
        // tray icon, and tray_setup is a deliberate no-op on a second call
        // (see solutions/infrastructure/plugin-host/native/tray.rs), so
        // there is nothing meaningful to unregister here.
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icon, tooltip, JSON.stringify(menu)]);

  return { ready: pluginReady() };
}
