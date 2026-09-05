// Skip `zig build --prefix .` when nothing that affects a local plugin's
// output has changed since the last successful build — mirrors bundling's
// BuildCache.ts, scoped to carbon/plugins/local instead of the app's own
// source tree.
//
// `zig build` is a genuine no-op when nothing changed (zig's own incremental
// cache confirms it has nothing to do), but the process-spawn + build-graph
// re-evaluation overhead is NOT free: measured at ~600-800ms on Windows
// against a single-local-plugin app, invoked unconditionally by
// SyncPluginsUseCase on every `carbon run`/`carbon dev` — often the single
// largest slice of total launch time for any app with a local plugin. This
// cache makes the overwhelmingly common "nothing changed" case near-zero.
//
// Cache file: carbon/bin/<os>/<arch>/.carbon-plugin-cache.json
//   Colocated with the staged artifacts on purpose: `carbon run --clean`
//   already wipes carbon/bin/ wholesale, so the cache invalidates for free
//   alongside the artifacts it's guarding — no separate cleanup path needed.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const CACHE_FILE_NAME = ".carbon-plugin-cache.json";

/** Directory names to skip when walking a local plugin's own source tree —
 *  its own build's scratch output, not a build INPUT. */
const SKIP_DIRS = new Set(["zig-cache", ".zig-cache", "zig-out"]);

interface CacheEntry {
  key: string;
  builtAt: string;
}

/** Walk a directory recursively, return every file's absolute path (sorted, for a stable hash). */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  function rec(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        rec(abs);
      } else if (st.isFile()) {
        out.push(abs);
      }
    }
  }
  rec(root);
  return out.sort();
}

/**
 * Sha256 over everything that can change what `zig build --prefix .` would
 * produce: manifest.toml (source/enabled flags — a plugin toggled off should
 * re-trigger), build.zig/build.zig.zon themselves, every local plugin's full
 * source tree, and the release/debug flag.
 *
 * Deliberately does NOT include the resolved zig binary's own fingerprint.
 * It used to — but computing that fingerprint means RESOLVING zig first
 * (`ensureZig`'s `zig version` + `where zig` probe subprocesses), which
 * measured at ~180-190ms on Windows and was being paid on every single
 * `carbon run`/`carbon dev` just to answer a cache-key question, even when
 * the answer was going to be "cache hit, do nothing." A zig toolchain
 * upgrade between two otherwise-unchanged launches not re-triggering a
 * rebuild is a real but vanishingly rare edge case (nothing else in this
 * cache's design tries to survive a toolchain change either — the compiled
 * plugin artifacts a prior zig version produced keep working); it doesn't
 * justify a ~190ms tax on every unchanged launch. `SyncPluginsUseCase` now
 * only resolves zig at all on an actual cache miss, when it's about to spend
 * real build time anyway.
 */
export function computePluginBuildKey(carbonDir: string, release: boolean): string {
  const h = createHash("sha256");
  h.update(`release=${release ? "1" : "0"}\n`);

  for (const name of ["manifest.toml", "build.zig", "build.zig.zon"]) {
    const p = join(carbonDir, name);
    if (!existsSync(p)) continue;
    h.update(`F\t${name}\t`);
    h.update(readFileSync(p));
    h.update("\n");
  }

  const localDir = join(carbonDir, "plugins", "local");
  if (existsSync(localDir)) {
    for (const abs of walkFiles(localDir)) {
      const rel = relative(carbonDir, abs).replace(/\\/g, "/");
      h.update(`L\t${rel}\t`);
      h.update(readFileSync(abs));
      h.update("\n");
    }
  }

  return h.digest("hex").slice(0, 32);
}

/** Read the existing cache entry for a given carbon/bin/<os>/<arch>/ dir. Null if missing/corrupt. */
export function readPluginBuildCache(binDir: string): CacheEntry | null {
  const path = join(binDir, CACHE_FILE_NAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

/**
 * Write the cache entry after a successful `zig build`. Best-effort: a
 * failure here (binDir doesn't exist yet on some unusual host layout, a
 * permissions issue, …) must not fail the sync that already succeeded — the
 * only cost of losing this write is the NEXT run rebuilding instead of
 * hitting cache, same as if this file were deleted by hand.
 */
export function writePluginBuildCache(binDir: string, key: string): void {
  try {
    const path = join(binDir, CACHE_FILE_NAME);
    const entry: CacheEntry = { key, builtAt: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(entry, null, 2));
  } catch {
    /* best-effort — see doc comment above */
  }
}
