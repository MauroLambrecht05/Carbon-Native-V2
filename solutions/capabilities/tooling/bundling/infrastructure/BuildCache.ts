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
import { runtimeBinaryPath } from "@carbon/workspace";
import { type BackendName } from "@carbon/contracts/app/backend";

// In compiled (`bun build --compile`) mode `import.meta.url` points inside the
// embedded VFS (e.g. file:///%7EBUN/root/...), not at the .exe on disk.
// Fall back to process.execPath so the CLI fingerprint hashes the binary itself.
const CACHE_FILE_NAME = ".carbon-cache.json";

/**
 * Bumped whenever hash-affecting logic changes in EITHER this file or its
 * Rust port, `solutions/capabilities/tooling/build-cache/rust`'s
 * `CACHE_SCHEMA_VERSION` (products/carbon-launcher's native `run`/`dev` use
 * that port instead of this file — see its own header comment for why).
 *
 * This used to be a fingerprint of the CLI's OWN binary (mtime+size of
 * process.execPath in compiled mode, or a walk of the CLI's source directory
 * otherwise) — meaningful when exactly one tool ever computed this key. Once
 * a second, independent implementation (the Rust port) started computing and
 * consuming the SAME dist/.carbon-cache.json, a per-binary fingerprint broke
 * cross-tool cache sharing outright: the TS CLI's own binary and
 * carbon-launcher's binary are two different files with two different
 * mtimes, so every switch between `carbon build` (still TS) and a native
 * `carbon run` would compute a different key and force a needless rebuild,
 * even when nothing relevant had changed. A single hardcoded version string,
 * duplicated in both implementations, is the fix: it's the same value
 * regardless of which tool is asking, and it still gets bumped by a human
 * (not silently drifting) exactly when it should.
 */
const CACHE_SCHEMA_VERSION = "1";

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

/** A walk's output: the tracked files found, AND every directory `rec`
 *  successfully `readdirSync`'d into — the latter is what lets
 *  `computeCacheKey` skip re-walking a tree whose directories haven't
 *  changed (see its own doc comment). Every walker below returns this
 *  shape now, not a bare file list, so the skip-check has full coverage. */
interface WalkResult {
  files: string[];
  dirs: string[];
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
function walkWorkspaceDeps(consumerDir: string): WalkResult {
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

  const outFiles: string[] = [];
  const outDirs: string[] = [];
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
      const sub = walkSources(depDir);
      outFiles.push(...sub.files);
      outDirs.push(...sub.dirs);
      rec(depDir);
    }
  }
  rec(consumerDir);
  return { files: Array.from(new Set(outFiles)).sort(), dirs: Array.from(new Set(outDirs)).sort() };
}

/**
 * Walk every directory (or exact file) a scaffolded app's own tsconfig.json
 * `compilerOptions.paths` points at — `@carbon/plugins/*`,
 * `@carbon/mini-react`, etc. — return their tracked source files.
 *
 * These are resolved by Bun's bundler at build time (it reads tsconfig
 * `paths` natively, the same way tsc/the editor do — see
 * BunBundler.ts and every carbon-scaffolded tsconfig.json's `paths`
 * block), but they are NOT a `dependencies`/`devDependencies` entry in the
 * app's package.json, so `walkWorkspaceDeps` never sees them. Without this,
 * editing a shared file under solutions/interface/plugins/ or
 * solutions/interface/renderer/ doesn't change the cache key at all — the
 * app-relative `carbon dev`/`run` keeps serving a stale bundle until
 * dist/.carbon-cache.json is deleted by hand. Reproduced directly: editing
 * a plugin hook and re-running `carbon run` logged "cache hit" and launched
 * the pre-edit behavior with zero errors.
 *
 * No `extends` support — every carbon-scaffolded tsconfig.json is
 * self-contained (see project-files.ts's TSCONFIG_REACT/TSCONFIG_SOLID),
 * so this reads `paths` directly off `<projectDir>/tsconfig.json`, the same
 * "good enough for what carbon actually generates" posture boundaries.ts's
 * own tsconfig alias reader already takes.
 */
function walkTsconfigPathAliases(projectDir: string): WalkResult {
  const tsconfigPath = join(projectDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return { files: [], dirs: [] };
  let paths: Record<string, string[]>;
  try {
    paths = JSON.parse(readFileSync(tsconfigPath, "utf8"))?.compilerOptions?.paths ?? {};
  } catch {
    return { files: [], dirs: [] };
  }

  const outFiles: string[] = [];
  const outDirs: string[] = [];
  const seenDirs = new Set<string>();
  for (const targets of Object.values(paths)) {
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      if (typeof target !== "string") continue;
      // tsc resolves `paths` relative to `baseUrl`, defaulting to the
      // tsconfig's own directory when baseUrl is absent — true for every
      // carbon-scaffolded tsconfig. `resolve` no-ops when target is already
      // absolute (the common case: scaffolding substitutes an absolute
      // @@ROOT@@ for a standalone install).
      const resolved = resolve(projectDir, target.replace(/\*$/, ""));
      if (/\.(ts|tsx|js|jsx|mjs)$/.test(resolved)) {
        outFiles.push(resolved); // exact file target, e.g. "@carbon/plugins" -> index.ts
        continue;
      }
      if (seenDirs.has(resolved)) continue;
      seenDirs.add(resolved);
      const sub = walkSources(resolved);
      outFiles.push(...sub.files);
      outDirs.push(...sub.dirs);
    }
  }
  return { files: Array.from(new Set(outFiles)).sort(), dirs: Array.from(new Set(outDirs)).sort() };
}

/** Walk the project dir, return absolute paths of all tracked files (plus
 *  every directory actually descended into — see `WalkResult`). */
function walkSources(root: string): WalkResult {
  const files: string[] = [];
  const dirs: string[] = [];
  function rec(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Doesn't exist / unreadable — not recorded in `dirs`, so a caller
      // checking "does this remembered directory still have the same
      // mtime" correctly treats a vanished directory as a change, not a
      // silent pass (there is no mtime to compare an absent dir against).
      return;
    }
    dirs.push(dir);
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
          files.push(abs);
        }
      }
    }
  }
  rec(root);
  return { files: files.sort(), dirs: dirs.sort() };
}

/**
 * One tracked source file's identity for the cheap staleness pre-check
 * below — NOT its content. `t` matches the F/W/P tag `computeCacheKey`'s
 * slow path hashes under; `p` is the same path string that path's `h.update`
 * call uses, so the two stay in lockstep by construction, not convention.
 */
interface StatEntry {
  t: "F" | "W" | "P";
  p: string;
  s: number;
  m: number;
}

/** One directory the last full walk successfully `readdirSync`'d into —
 *  see the "skip the walk itself" section of computeCacheKey's doc
 *  comment for what this buys. */
interface DirEntry {
  p: string;
  m: number;
}

/** `dist/.carbon-cache-stat.json` — sidecar to `dist/.carbon-cache.json`,
 *  colocated on purpose (see that file's own storage comment): wiping
 *  dist/ (a `--clean`, or just deleting the cache) invalidates this for
 *  free too, no separate cleanup path. */
function statSidecarPath(projectDir: string): string {
  return join(projectDir, "dist", ".carbon-cache-stat.json");
}

interface StatSidecar {
  /** sha256 (full hex, not truncated) over exactly the F/W/P content this
   *  `stat` list describes — see computeCacheKey's SRC tag. */
  sourceHash: string;
  stat: StatEntry[];
  dirs: DirEntry[];
}

function readStatSidecar(projectDir: string): StatSidecar | null {
  const p = statSidecarPath(projectDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StatSidecar;
  } catch {
    return null;
  }
}

/** Best-effort: a failed write just means the NEXT launch pays the full
 *  content-hash cost once more, same as if this file didn't exist — never
 *  a reason to fail the cache-key computation that already succeeded. */
function writeStatSidecar(projectDir: string, entry: StatSidecar): void {
  try {
    writeFileSync(statSidecarPath(projectDir), JSON.stringify(entry));
  } catch {
    /* best-effort — see doc comment above */
  }
}

/** A failed `stat` (file vanished between the walk and here — a real, if
 *  rare, race) reads as a guaranteed-mismatch sentinel rather than
 *  throwing, so the caller falls
 *  through to the slow (always-correct) content-hash path instead of
 *  crashing the whole cache-key computation over one racy file. */
function safeStatEntry(t: StatEntry["t"], p: string, abs: string): StatEntry {
  try {
    const st = statSync(abs);
    return { t, p, s: st.size, m: st.mtimeMs };
  } catch {
    return { t, p, s: -1, m: -1 };
  }
}

function statEntriesEqual(a: StatEntry[], b: StatEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.t !== y.t || x.p !== y.p || x.s !== y.s || x.m !== y.m) return false;
  }
  return true;
}

/** Same failure posture as `safeStatEntry`: a directory that no longer
 *  stats reads as `-1`, a value no real mtime ever equals, so a vanished
 *  directory is always a mismatch, never a silent pass. */
function safeDirMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * True only if EVERY directory the last full walk descended into still has
 * the exact mtime it had then. Adding, removing, or renaming a file bumps
 * its immediate parent directory's mtime — on NTFS and every other
 * filesystem this matters for — so this is proof that the file SET inside
 * every one of these directories is unchanged, without re-listing any of
 * them. An empty list is never trusted (nothing recorded yet, or the walk
 * that produced it recorded zero directories, which only a totally
 * unreadable project root would do — either way, not something to trust).
 */
function dirsUnchanged(dirs: DirEntry[]): boolean {
  if (dirs.length === 0) return false;
  for (const d of dirs) {
    if (safeDirMtime(d.p) !== d.m) return false;
  }
  return true;
}

/**
 * True unless `package.json` or `tsconfig.json` — anywhere in the tracked
 * set, not just the app's own root: a workspace dep's `package.json`
 * counts too — has changed. These two are special: they don't just affect
 * hashed CONTENT, they drive which files `walkWorkspaceDeps`/
 * `walkTsconfigPathAliases` discover in the first place (new dependency,
 * new path alias, a workspace dep's own new transitive dependency). A
 * directory-mtime match proves the file SET inside already-known
 * directories hasn't changed, but says nothing about a NEWLY-relevant
 * directory these two files might now point at — one that was never
 * walked before, so no directory-mtime check could ever have covered it.
 * This is the safety net for exactly that gap: either file changing forces
 * a real walk regardless of what every remembered directory mtime says.
 */
function structuralFilesUnchanged(projectDir: string, stat: StatEntry[]): boolean {
  for (const e of stat) {
    const base = e.p.slice(e.p.lastIndexOf("/") + 1);
    if (base !== "package.json" && base !== "tsconfig.json") continue;
    const abs = e.t === "F" ? join(projectDir, e.p) : e.p;
    const cur = safeStatEntry(e.t, e.p, abs);
    if (cur.s !== e.s || cur.m !== e.m) return false;
  }
  return true;
}

/**
 * Compute a sha256 over: every tracked file's path + content + the runtime
 * binary's mtime + CLI version.
 *
 * The F/W/P (tracked source / workspace-dep / tsconfig-path-alias) discovery
 * + content hash is the expensive part of this function — it used to run on
 * EVERY call, walking every tracked directory AND reading+hashing the full
 * byte content of every tracked file, every single `carbon run`/`carbon
 * dev` launch, even when nothing had changed since the last one. Measured
 * on a real app: ~16ms directory walk + ~6ms per-file stat + (before the
 * first fix below existed) 30-56ms of content reads — the single largest
 * remaining piece of `carbon run`'s pre-spawn CLI overhead once the
 * plugin-build and window-visible fixes landed.
 *
 * Two layered cheap-staleness pre-checks, cheapest first, each one only
 * mattering when the one before it couldn't fully answer "did anything
 * change":
 *
 * 1. Skip the CONTENT hash. `dist/.carbon-cache-stat.json` (see
 *    `StatSidecar`) remembers the exact (tag, path, size, mtime) triple for
 *    every F/W/P file the LAST full content-hash computation saw. `stat()`
 *    (not `read()`) the same files — if the file SET and every size+mtime
 *    are byte-identical to what's remembered, the content cannot have
 *    changed either (the same trick Make/ninja/Bazel use to avoid
 *    re-hashing unchanged trees — a size+mtime match isn't a cryptographic
 *    proof of unchanged content, but every existing cheap-fingerprint
 *    elsewhere in this file — the RT/CLI-compiled tags below — already
 *    accepts exactly this tradeoff), so the previously-computed content
 *    hash is reused.
 *
 * 2. Skip the WALK itself. Even `stat()`-only, discovering WHICH files to
 *    check still means recursing every tracked directory (`walkSources` /
 *    `walkWorkspaceDeps` / `walkTsconfigPathAliases`) via `readdirSync`.
 *    `dirsUnchanged` answers "has the file SET in any of these directories
 *    changed" from remembered directory mtimes alone, no listing required
 *    — see its own doc comment. When it says no (and `structuralFilesUnchanged`
 *    confirms `package.json`/`tsconfig.json` themselves didn't change,
 *    closing the "a newly-added dependency/alias points somewhere never
 *    walked before" gap directory mtimes alone can't cover), the walk is
 *    skipped entirely and the remembered file list from the sidecar is
 *    reused directly — still independently re-`stat()`'d per file (layer 1
 *    above), never trusted for content on directory evidence alone.
 *
 * Any mismatch at either layer — a file added/removed/edited, a dependency
 * or path alias changed — falls straight through to the original
 * always-correct full walk + read + hash, which then refreshes the sidecar
 * for the next call.
 */
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

  // Layer 2: try to skip the walk itself first — see computeCacheKey's own
  // doc comment. Only trusted when the sidecar has a non-empty `dirs` list
  // (dirsUnchanged's own posture) AND package.json/tsconfig.json themselves
  // are unchanged (structuralFilesUnchanged — the "newly-relevant directory
  // no mtime check could have covered" safety net).
  const sidecar = readStatSidecar(projectDir);
  const canSkipWalk =
    !!sidecar && dirsUnchanged(sidecar.dirs) && structuralFilesUnchanged(projectDir, sidecar.stat);

  // Tag+path+abs for every tracked file, either reconstructed from the
  // sidecar (walk skipped) or freshly discovered (real walk) — from here
  // down, both paths are handled identically.
  let tracked: { t: StatEntry["t"]; p: string; abs: string }[];
  let currentDirs: DirEntry[];
  if (canSkipWalk) {
    tracked = sidecar!.stat.map((e) => ({
      t: e.t,
      p: e.p,
      abs: e.t === "F" ? join(projectDir, e.p) : e.p,
    }));
    currentDirs = sidecar!.dirs;
  } else {
    const filesW = walkSources(projectDir);
    const depW = walkWorkspaceDeps(projectDir);
    const aliasW = walkTsconfigPathAliases(projectDir);
    tracked = [
      ...filesW.files.map((abs) => ({
        t: "F" as const,
        p: relative(projectDir, abs).replace(/\\/g, "/"),
        abs,
      })),
      ...depW.files.map((abs) => ({ t: "W" as const, p: abs.replace(/\\/g, "/"), abs })),
      ...aliasW.files.map((abs) => ({ t: "P" as const, p: abs.replace(/\\/g, "/"), abs })),
    ];
    const dirMap = new Map<string, number>();
    for (const d of [...filesW.dirs, ...depW.dirs, ...aliasW.dirs]) {
      if (!dirMap.has(d)) dirMap.set(d, safeDirMtime(d));
    }
    currentDirs = Array.from(dirMap, ([p, m]) => ({ p, m })).sort((a, b) => a.p.localeCompare(b.p));
  }

  // Layer 1: skip the CONTENT hash when every tracked file's own stat still
  // matches — independent of (and always re-checked regardless of) whether
  // layer 2 skipped the walk above. This is what actually catches an
  // in-place edit to a file the walk-skip path reused from the sidecar.
  const currentStat: StatEntry[] = tracked.map((f) => safeStatEntry(f.t, f.p, f.abs));

  let sourceHash: string;
  if (sidecar && statEntriesEqual(sidecar.stat, currentStat)) {
    sourceHash = sidecar.sourceHash;
  } else {
    // Tagged F (own source)/W (workspace dep)/P (tsconfig path alias) —
    // see the walker functions above for what each covers; the tag+path
    // scheme here (not just content) is what stops e.g. two consumers of
    // the same workspace package from colliding on a partial relative path.
    const sh = createHash("sha256");
    for (const f of tracked) {
      sh.update(`${f.t}\t${f.p}\t`);
      sh.update(readFileSync(f.abs));
      sh.update("\n");
    }
    sourceHash = sh.digest("hex");
    writeStatSidecar(projectDir, { sourceHash, stat: currentStat, dirs: currentDirs });
  }
  h.update(`SRC\t${sourceHash}\n`);

  // Runtime binary fingerprint — if the runtime is recompiled, all caches invalidate.
  const exe = runtimeBinaryPath(backend);
  if (existsSync(exe)) {
    const st = statSync(exe);
    h.update(`RT\t${st.size}\t${st.mtimeMs.toFixed(0)}\n`);
  }

  // Schema fingerprint — see CACHE_SCHEMA_VERSION's own doc comment for why
  // this replaced a per-CLI-binary fingerprint.
  h.update(`SCHEMA\t${CACHE_SCHEMA_VERSION}\n`);

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
