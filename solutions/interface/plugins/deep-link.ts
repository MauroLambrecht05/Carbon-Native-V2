// @carbon/plugins/deep-link — custom URL scheme handling (`myapp://...`).
//
// import { useDeepLink } from "@carbon/plugins/deep-link";
// useDeepLink("myapp", (url) => console.log("opened via", url));
//
// Registers the scheme with the OS at runtime on Windows/Linux. NOT
// supported at runtime on macOS — CFBundleURLTypes must be declared in
// Info.plist at package time instead (see the dmg packaging generator);
// `register()` there is a documented no-op that returns false, not a
// silent failure.
//
// Like global-shortcuts/tray, this needs `useEffect` — registering a
// scheme handler is a one-time setup with delivery over time (a
// subscription), not a value fetched synchronously.
//
// KNOWN LIMIT: a second launch's window may flash briefly before the
// native side detects the first instance and exits that process — no
// lifecycle hook exists early enough for a plugin to prevent that
// entirely (plugins load after the window already exists). See
// solutions/infrastructure/plugin-host/native/deeplink.rs for the full
// picture, including why single-instance detection uses a loopback TCP
// port rather than a named pipe / Unix socket.

import { useEffect, useRef } from "react";
import { register as rawRegister } from "carbon:deep-link";

export interface UseDeepLinkResult {
  ready: boolean;
}

function pluginReady(): boolean {
  return typeof (globalThis as unknown as { deepLinkRegister?: unknown }).deepLinkRegister === "function";
}

export function useDeepLink(scheme: string, onUrl: (url: string) => void): UseDeepLinkResult {
  // A ref, not `onUrl` in the dependency array — a fresh (non-memoized)
  // callback each render shouldn't tear down and re-register the scheme.
  const onUrlRef = useRef(onUrl);
  onUrlRef.current = onUrl;

  useEffect(() => {
    if (!pluginReady()) return;

    const carbon = (globalThis as unknown as { carbon?: { on: Function; off: Function } }).carbon;
    if (!carbon) return;

    const listener = (payload: { url: string } | null) => {
      if (payload?.url) onUrlRef.current(payload.url);
    };
    carbon.on("deeplink.url", listener);

    // Registration itself may forward this launch's URL to an
    // already-running instance and exit the process — nothing after this
    // call is guaranteed to run in that case.
    rawRegister(scheme);

    return () => {
      carbon.off("deeplink.url", listener);
    };
  }, [scheme]);

  return { ready: pluginReady() };
}
