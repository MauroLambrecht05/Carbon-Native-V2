// @carbon/plugins/notification — a desktop toast through the OS
// notification centre.
//
// import { useNotification } from "@carbon/plugins/notification";
// const { send } = useNotification();
// send("Build complete", "Your app is ready.");
//
// No requestAnimationFrame-deferral needed — see clipboard.ts's module doc
// comment for why (this, too, is only ever called from an event handler,
// well after plugin registration has already happened).

import { useCallback } from "react";
import { send as rawSend } from "carbon:notification";

export interface UseNotificationResult {
  send: (title: string, body: string, icon?: string) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return typeof (globalThis as unknown as { send?: unknown }).send === "function";
}

export function useNotification(): UseNotificationResult {
  const send = useCallback(
    (title: string, body: string, icon?: string): boolean =>
      pluginReady() ? rawSend(title, body, icon) : false,
    [],
  );

  return { send, ready: pluginReady() };
}
