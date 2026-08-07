// Build-cache: skip the Vite + bytecode-compile pipeline when none of the
// inputs that affect the output have changed since the last successful build.
//
// Cache key includes:
//   - Every file in the project that could affect compilation:
//       *.tsx, *.ts, *.jsx, *.js (excluding node_modules + dist)
//       *.css, *.svg
//       package.json, vite.config.{ts,js,mjs}, tsconfig.json
//       carbon.toml (because [runtime].bytecode toggle changes the artifact)
//   - The runtime binary's mtime (bytecode artifacts are runtime-version-locked
//     so a runtime rebuild invalidates everything)
//   - The CLI version (so updating @carbon/cli invalidates).
//
// Cache file: <projectDir>/dist/.carbon-cache.json
//   { "key": "<sha256-prefix>", "artifacts": ["dist/bundle.js", "dist/bundle.qbc.zst"] }
//
// On hit: skip the rebuild, log "cache hit", proceed to spawn.
// On miss: rebuild, then write the cache file.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeBinaryPath } from "@carbon/workspace";
import { type BackendName } from "@carbon/contracts/app/backend";

// In compiled (`bun build --compile`) mode `import.meta.url` points inside the
// embedded VFS (e.g. file:///%7EBUN/root/...), not at the .exe on disk.
// Fall back to process.execPath so the CLI fingerprint hashes the binary itself.
const META_URL = import.meta.url;
const IS_COMPILED =
  META_URL.includes("/$bunfs/") ||
  META_URL.includes("/~BUN/") ||
  META_URL.includes("/%7EBUN/") ||
  META_URL.includes("/%7Ebun/");
const CLI_DIR = IS_COMPILED
  ? dirname(process.execPath)
  : dirname(fileURLToPath(META_URL));
const CACHE_FILE_NAME = ".carbon-cache.json";

/** File extensions that affect the build output. */
const TRACKED_EXTS = new Set([
  ".tsx", ".ts", ".jsx", ".js", ".mjs",
  ".css", ".svg", ".html",
  ".toml", ".json",
]);

/** Directory names to skip when walking. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".carbon-cache", "target", ".git",
]);

/** File names that are always cache inputs (even outside src/). */
const ALWAYS_INCLUDE = new Set([
  "package.json", "carbon.toml", "tsconfig.json",
  "vite.config.ts", "vite.config.js", "vite.config.mjs",
]);

interface CacheEntry {
  key: string;
  artifacts: string[];
  /** ISO timestamp for human inspection. */
  builtAt: string;
}

/**
 * Walk every workspace dep transitively reachable from `consumerDir`'s
 * `package.json`, return their tracked source files. Handles both:
 *   - `file:../path/to/pkg`   — bun copies into node_modules at install time
 *   - `workspace:*` (or `^`)  — bun resolves via the monorepo root's
 *                                `workspaces` patterns
 *
 * Without this walker the cache hash misses workspace edits and serves a
 * stale bundle (e.g. the "state lost on theme toggle" trap after editing
 * `packages/react-mini-runtime` while the consumer's own files were
 * unchanged). Cycles broken by canonicalizing each dep dir before recording.
 * We never descend into a dep's own `node_modules` — `walkSources` already
 * skips that.
 */
function walkWorkspaceDeps(consumerDir: string): string[] {
  type Pj = {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    workspaces?: string[];
  };

  function readPj(dir: string): Pj | null {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8")) as Pj; } catch { return null; }
  }

  // Lazily build name → dir map by walking up to the monorepo root and
  // expanding its `workspaces` patterns. Only built when a `workspace:` spec
  // is encountered, so non-monorepo consumers pay nothing.
  let nameMap: Map<string, string> | null = null;
  function workspaceMap(): Map<string, string> {
    if (nameMap) return nameMap;
    nameMap = new Map();
    let root: string | null = null;
    let dir = consumerDir;
    while (true) {
      const pj = readPj(dir);
      if (pj && Array.isArray(pj.workspaces) && pj.workspaces.length > 0) {
        root = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!root) return nameMap;
    const rootPj = readPj(root);
    const patterns = rootPj?.workspaces ?? [];
    for (const pat of patterns) {
      const star = pat.indexOf("*");
      if (star < 0) {
        const d = resolve(root, pat);
        const pj = readPj(d);
        if (pj?.name) nameMap.set(pj.name, d);
      } else {
        const base = pat.slice(0, star).replace(/[\\/]$/, "");
        const baseDir = resolve(root, base);
        if (!existsSync(baseDir)) continue;
        let entries: string[];
        try { entries = readdirSync(baseDir); } catch { continue; }
        for (const e of entries) {
          const d = join(baseDir, e);
          const pj = readPj(d);
          if (pj?.name) nameMap.set(pj.name, d);
        }
      }
    }
    return nameMap;
  }

  const out: string[] = [];
  const visited = new Set<string>();
  function rec(dir: string) {
    let canon: string;
    try { canon = realpathSync(dir); } catch { canon = resolve(dir); }
    if (visited.has(canon)) return;
    visited.add(canon);
    const pj = readPj(canon);
    if (!pj) return;
    const all: Record<string, string> = {
      ...(pj.dependencies ?? {}),
      ...(pj.devDependencies ?? {}),
      ...(pj.peerDependencies ?? {}),
    };
    for (const [name, spec] of Object.entries(all)) {
      if (typeof spec !== "string") continue;
      let depDir: string | null = null;
      if (spec.startsWith("file:")) {
        depDir = resolve(canon, spec.slice(5));
      } else if (spec.startsWith("workspace:")) {
        depDir = workspaceMap().get(name) ?? null;
      } else {
        continue; // npm-registry deps don't change between cache checks
      }
      if (!depDir || !existsSync(depDir)) continue;
      out.push(...walkSources(depDir));
      rec(depDir);
    }
  }
  rec(consumerDir);
  return Array.from(new Set(out)).sort();
}

/** Walk the project dir, return absolute paths of all tracked files. */
function walkSources(root: string): string[] {
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
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith(".")) continue;  // .git, .vscode, .carbon-cache, …
        rec(abs);
      } else if (st.isFile()) {
        const dot = name.lastIndexOf(".");
        const ext = dot >= 0 ? name.slice(dot) : "";
        if (TRACKED_EXTS.has(ext) || ALWAYS_INCLUDE.has(name)) {
          out.push(abs);
        }
      }
    }
  }
  rec(root);
  return out.sort();
}

/** Compute a sha256 over: every tracked file's path + content + the runtime binary's mtime + CLI version. */
export function computeCacheKey(
  projectDir: string,
  backend: BackendName,
  bytecode: boolean,
  dev: boolean = false,
): string {
  const h = createHash("sha256");

  // Mark inputs that change cache semantics (so flipping bytecode triggers a rebuild).
  h.update(`backend=${backend}\n`);
  h.update(`bytecode=${bytecode ? "1" : "0"}\n`);
  // Dev builds emit an IIFE-wrapped (HMR-safe) bundle; production builds emit
  // an unwrapped one. Same inputs, DIFFERENT artifact — so the dev artifact
  // must not satisfy a `carbon run` cache check and vice versa. Folded in
  // only when dev=true so production keys stay byte-identical to the Rust
  // hot-path's key (which never builds in dev mode).
  if (dev) h.update(`dev=1\n`);

  // Source files
  const files = walkSources(projectDir);
  for (const abs of files) {
    const rel = relative(projectDir, abs).replace(/\\/g, "/");
    h.update(`F\t${rel}\t`);
    h.update(readFileSync(abs));
    h.update("\n");
  }

  // Workspace `file:` / `workspace:` dep contents — see `walkWorkspaceDeps`
  // for why these can't be derived from the consumer's tree alone. Hashed
  // separately (W tag) and identified by their absolute path so two
  // consumers depending on the same workspace pkg don't collide on partial-
  // rel-path entries.
  const depFiles = walkWorkspaceDeps(projectDir);
  for (const abs of depFiles) {
    h.update(`W\t${abs.replace(/\\/g, "/")}\t`);
    h.update(readFileSync(abs));
    h.update("\n");
  }

  // Runtime binary fingerprint — if the runtime is recompiled, all caches invalidate.
  const exe = runtimeBinaryPath(backend);
  if (existsSync(exe)) {
    const st = statSync(exe);
    h.update(`RT\t${st.size}\t${st.mtimeMs.toFixed(0)}\n`);
  }

  // CLI fingerprint — pin to this CLI's mtime so a CLI edit invalidates.
  // Compiled mode: just stat the .exe; source mode: walk cli/src/ (small).
  if (IS_COMPILED) {
    try {
      const st = statSync(process.execPath);
      h.update(`CLI\tcompiled\t${st.size}\t${st.mtimeMs.toFixed(0)}\n`);
    } catch { /* ignore */ }
  } else {
    const cliSrc = join(CLI_DIR);
    try {
      const cliFiles = walkSources(cliSrc);
      for (const f of cliFiles) {
        const st = statSync(f);
        h.update(`CLI\t${relative(CLI_DIR, f).replace(/\\/g, "/")}\t${st.size}\t${st.mtimeMs.toFixed(0)}\n`);
      }
    } catch { /* ignore */ }
  }

  return h.digest("hex").slice(0, 32);
}

/** Read the existing cache entry (if any). Returns null if missing/corrupt. */
export function readCache(projectDir: string): CacheEntry | null {
  const path = join(projectDir, "dist", CACHE_FILE_NAME);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text) as CacheEntry;
  } catch {
    return null;
  }
}

/** True if ALL listed artifacts still exist on disk. */
export function artifactsExist(projectDir: string, artifacts: string[]): boolean {
  return artifacts.every((rel) => existsSync(join(projectDir, rel)));
}

/** Write the cache entry after a successful build. */
export function writeCache(
  projectDir: string,
  key: string,
  artifacts: string[],
): void {
  const path = join(projectDir, "dist", CACHE_FILE_NAME);
  const entry: CacheEntry = {
    key,
    artifacts,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(entry, null, 2));
}

/** List of artifact paths (relative to project) we expect after a successful build. */
export function expectedArtifacts(projectDir: string, bytecode: boolean): string[] {
  const out: string[] = [];
  // The Vite + bun-build flows both produce dist/bundle.js (or dist/ui/index.html).
  // We track both possibilities — present-or-not is checked by artifactsExist.
  const candidates = [
    "dist/bundle.js",
    "dist/ui/index.html",
    "dist/shell.js",
  ];
  for (const c of candidates) {
    if (existsSync(join(projectDir, c))) out.push(c);
  }
  if (bytecode) {
    // bytecode mode: also expect .qbc.zst as the load-preference target.
    if (existsSync(join(projectDir, "dist/bundle.qbc.zst"))) {
      out.push("dist/bundle.qbc.zst");
    }
    if (existsSync(join(projectDir, "dist/shell.qbc.zst"))) {
      out.push("dist/shell.qbc.zst");
    }
  }
  return out;
}
