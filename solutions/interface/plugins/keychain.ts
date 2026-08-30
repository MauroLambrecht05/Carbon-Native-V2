// @carbon/plugins/keychain — the OS credential store, keyed by (service,
// account).
//
// import { useKeychain } from "@carbon/plugins/keychain";
// const { set, get, remove } = useKeychain();
// set("my-app", "openai-api-key", token);
//
// `remove`, not `delete`: `delete` is a reserved word and can't be a
// function declaration's name — see carbon-sdk/keychain's carbon-plugin.toml
// for the export-name/global-name split this required.
//
// No requestAnimationFrame-deferral needed — see clipboard.ts's module doc
// comment for why (only ever called from an event handler, well after
// plugin registration has already happened).

import { useCallback } from "react";
import { set as rawSet, get as rawGet, remove as rawRemove } from "carbon:keychain";

export interface UseKeychainResult {
  set: (service: string, account: string, password: string) => boolean;
  /** Returns null when no entry exists, when the plugin isn't ready yet, or on error. */
  get: (service: string, account: string) => string | null;
  remove: (service: string, account: string) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return typeof (globalThis as unknown as { delete?: unknown }).delete === "function";
}

export function useKeychain(): UseKeychainResult {
  const set = useCallback(
    (service: string, account: string, password: string): boolean =>
      pluginReady() ? rawSet(service, account, password) : false,
    [],
  );
  const get = useCallback(
    (service: string, account: string): string | null => (pluginReady() ? rawGet(service, account) : null),
    [],
  );
  const remove = useCallback(
    (service: string, account: string): boolean => (pluginReady() ? rawRemove(service, account) : false),
    [],
  );

  return { set, get, remove, ready: pluginReady() };
}
