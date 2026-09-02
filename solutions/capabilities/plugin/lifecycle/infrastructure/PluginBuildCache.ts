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
 * source tree, the release/debug flag, and the resolved zig binary's own
 * fingerprint (a toolchain upgrade must invalidate too).
 */
export function computePluginBuildKey(
  carbonDir: string,
  zigPath: string,
  release: boolean,
): string {
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

  // Not fatal if unresolvable (e.g. a test double resolveZig returning a bare
  // "zig" string with nothing on disk at that path) — the key is just missing
  // one input in that case, same posture as BuildCache.ts's runtime-binary stat.
  try {
    const st = statSync(zigPath);
    h.update(`ZIG\t${st.size}\t${st.mtimeMs.toFixed(0)}\n`);
  } catch {
    /* ignore */
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
