// keychain — the OS credential store, keyed by (service, account).

declare const __cm_keychain_set: (service: string, account: string, password: string) => void;
declare const __cm_keychain_get: (service: string, account: string) => string | null;
declare const __cm_keychain_delete: (service: string, account: string) => void;

export const keychain = {
  /** Store a credential keyed by (service, account). */
  set: (service: string, account: string, password: string): void =>
    __cm_keychain_set(service, account, password),
  /** Returns null when no entry exists for (service, account). */
  get: (service: string, account: string): string | null =>
    __cm_keychain_get(service, account),
  /** Idempotent — deleting a missing entry is a no-op, not an error. */
  delete: (service: string, account: string): void =>
    __cm_keychain_delete(service, account),
};
