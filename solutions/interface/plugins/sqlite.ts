// @carbon/plugins/sqlite — embedded SQLite storage.
//
// import { useSqlite } from "@carbon/plugins/sqlite";
// const { exec } = useSqlite();
// exec("app.db", "INSERT INTO notes (text) VALUES (?1)", ["hello"]);
// const rows = exec("app.db", "SELECT * FROM notes");
//
// NOT enabled by default yet — see the sqlite plugin's own main.zig header
// comment: carbon-plugin-host's own binary needs to be built with
// `--features sqlite` (deliberately left out of its default feature set,
// unlike every other carbon-sdk plugin, since it's real compiled-C
// weight). Installing this plugin alone isn't sufficient until that
// build-wiring lands; `exec` will consistently return `null` against a
// runtime that wasn't built with the feature.
//
// `db_path` is resolved relative to the app's project directory unless
// absolute. `params` (optional): null/boolean/number/string values only —
// see carbon_plugin.h's sqlite_exec doc comment for the full scope note.
// No requestAnimationFrame-deferral needed — see clipboard.ts's module doc
// comment for why (only ever called from an event handler, well after
// plugin registration has already happened).

import { useCallback } from "react";
import { exec as rawExec } from "carbon:sqlite";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export type SqlParam = null | boolean | number | string;

export interface UseSqliteResult {
  /**
   * Returns an array of row objects for a SELECT, `{changes,
   * lastInsertRowid}` for an INSERT/UPDATE/DELETE, or `null` if the
   * plugin isn't ready yet or the call failed.
   */
  exec: (dbPath: string, sql: string, params?: SqlParam[]) => unknown;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("exec");
}

export function useSqlite(): UseSqliteResult {
  const exec = useCallback((dbPath: string, sql: string, params?: SqlParam[]): unknown => {
    if (!pluginReady()) return null;
    return rawExec(dbPath, sql, params ?? []);
  }, []);

  return { exec, ready: pluginReady() };
}
