// App self-update port. Thin wrapper around `shared/updater`'s
// engine surface (when present) — checks the configured update channel,
// returns an `Update` if a newer version is available, lets the caller
// download + apply + relaunch.
//
//   import { check } from "@carbon/api/updater";
//   const up = await check();
//   if (up?.available) { await up.downloadAndInstall(); await relaunch(); }

import { invoke, hasCommand } from "./invoke";

/** Progress event shape matches Tauri's plugin-updater so ports keep
 *  their `case "Started" / "Progress" / "Finished"` callback bodies. */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface Update {
  /** Always true when this object is returned — `check()` returns null
   *  if no update is available, so callers don't need this in practice. */
  available: true;
  /** Semver of the new version (e.g. "0.6.5"). */
  version: string;
  /** Current installed version (the one running). */
  currentVersion: string;
  /** Release notes text or null if the manifest didn't include any. */
  body: string | null;
  /** ISO 8601 timestamp from the update manifest. */
  date: string | null;
  /** Pull the update bytes + apply them. The progress callback fires
   *  with Tauri-shaped DownloadEvents — Started → Progress* → Finished —
   *  so ports keep their existing switch/case handlers. Caller relaunches
   *  after via `@carbon/api/process`'s `relaunch()`. */
  downloadAndInstall(onProgress?: (ev: DownloadEvent) => void): Promise<void>;
}

/** Hit the configured update endpoint. Returns null when the running
 *  version matches the latest; returns an `Update` when there's a
 *  newer one to install. Throws on network / endpoint errors. */
export async function check(): Promise<Update | null> {
  if (!hasCommand("updater:check")) return null;
  const res = await invoke<{
    available: boolean;
    version: string;
    currentVersion: string;
    body: string | null;
    date: string | null;
  } | null>("updater:check");
  if (!res || !res.available) return null;

  return {
    available: true,
    version: res.version,
    currentVersion: res.currentVersion,
    body: res.body,
    date: res.date,
    async downloadAndInstall(onProgress) {
      // Engine streams DownloadEvents through a Channel; until the
      // carbon-updater surface stabilises this calls the install
      // synchronously and fires a Started → Finished pair for any
      // listener that needs the bookend events.
      try { onProgress?.({ event: "Started", data: {} }); } catch { /* swallow */ }
      await invoke("updater:download_and_install");
      try { onProgress?.({ event: "Finished" }); } catch { /* swallow */ }
    },
  };
}
