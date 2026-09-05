// @carbon/plugins/menu — a native application menu bar (Windows only for
// now — see the menu plugin's own main.zig header comment).
//
// import { useMenu } from "@carbon/plugins/menu";
// useMenu(
//   [{ label: "File", items: [
//     { id: "open", label: "Open" },
//     { separator: true },
//     { id: "quit", label: "Quit", accelerator: "Ctrl+Q" },
//   ] }],
//   { onSelect: (id) => console.log("menu:", id) },
// );
//
// Setting a new menu replaces the window's current one — call this again
// (e.g. from a re-render) to change it; unlike tray, there's no "already
// set up, second call is a no-op" behavior to preserve. Needs `useEffect`
// for the same reason tray/global-shortcuts do: it's a subscription with a
// lifecycle, not a value fetched synchronously.

import { useEffect, useRef } from "react";
import { setup as rawSetup } from "carbon:menu";
import { awaitPluginReady, pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface MenuItemSpec {
  id: string;
  label: string;
  /** A muda/tray-icon-style accelerator string, e.g. `"Ctrl+Q"`. */
  accelerator?: string;
}

export interface MenuSeparatorSpec {
  separator: true;
}

export interface TopMenuSpec {
  label: string;
  items: (MenuItemSpec | MenuSeparatorSpec)[];
}

export interface MenuCallbacks {
  onSelect?: (id: string) => void;
}

export interface UseMenuResult {
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("setup");
}

export function useMenu(spec: TopMenuSpec[], callbacks: MenuCallbacks = {}): UseMenuResult {
  // Ref, not `callbacks` in the dependency array — see tray.ts's identical
  // reasoning: a caller passing a fresh `{ onSelect }` object every render
  // shouldn't tear down and recreate the listener each time.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    return awaitPluginReady(pluginReady, () => {
      rawSetup(spec);

      const carbon = (globalThis as unknown as { carbon?: { on: Function; off: Function } }).carbon;
      if (!carbon) return;

      const selectListener = (payload: { id: string } | null) => {
        if (payload?.id) callbacksRef.current.onSelect?.(payload.id);
      };
      carbon.on("menu.click", selectListener);

      return () => {
        carbon.off("menu.click", selectListener);
        // No teardown call to the native side — there's no "unset" verb
        // (see menu_setup's own doc comment in carbon_plugin.h); a caller
        // that wants no menu at all would need a real "remove" ABI entry,
        // not yet added since nothing has asked for it.
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(spec)]);

  return { ready: pluginReady() };
}
