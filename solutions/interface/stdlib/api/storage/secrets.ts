// OS-keychain-backed secret storage. Use for API keys, OAuth tokens,
// passwords — anything that shouldn't sit in plain text on disk.
//
// Engine maps to:
//   - Windows: Credential Manager (wincred)
//   - macOS:   Keychain Services (login.keychain)
//   - Linux:   Secret Service via libsecret (gnome-keyring / kwallet);
//              falls back to keyutils when D-Bus isn't running.
//
//   import * as secrets from "@carbon/api/secrets";
//   await secrets.set("terax", "openai-key", "sk-…");
//   const v = await secrets.get("terax", "openai-key");

import { invoke } from "../bridge/invoke.ts";

/** Read a secret. Returns null when the entry doesn't exist (no throw). */
export async function get(service: string, account: string): Promise<string | null> {
  return invoke<string | null>("secrets_get", { service, account });
}

/** Store a secret. Replaces any existing value for the same key. */
export async function set(service: string, account: string, password: string): Promise<void> {
  await invoke("secrets_set", { service, account, password });
}

/** Delete a secret. No-op if the entry doesn't exist. */
export async function del(service: string, account: string): Promise<void> {
  await invoke("secrets_delete", { service, account });
}

/** Batch read — returns null for accounts that don't have entries.
 *  Same order as `accounts`. */
export async function getAll(service: string, accounts: string[]): Promise<(string | null)[]> {
  return invoke<(string | null)[]>("secrets_get_all", { service, accounts });
}
