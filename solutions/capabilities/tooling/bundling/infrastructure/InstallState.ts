// Install-state stamp: answers "does `node_modules` still correspond to the
// package.json + lockfile that produced it?" without spawning a package
// manager to find out.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// `ensureNodeModules` used to install only when `node_modules` was absent.
// That is the wrong trigger for two independent reasons:
//
//   1. Correctness. Edit a version range in package.json, or pull a colleague's
//      lockfile change, and `node_modules` still exists — so nothing installs
//      and the build silently runs against the OLD tree. The lockfile is then
//      decorative: it pins what a fresh install would resolve, and a fresh
//      install is exactly what never happens.
//   2. Security, which is the reason this file was written. A lockfile is the
//      artifact that says "these exact versions were reviewed." If the build
//      never re-checks it, a drifted package.json is never noticed, and
//      `--frozen-lockfile` on the one install that does happen protects
//      nothing.
//
// The obvious fix — run `bun install --frozen-lockfile` unconditionally — is
// not free. Measured on bun 1.3.10, a fully in-sync tree still costs ~45 ms of
// bun plus a process spawn, and `ensureNodeModules` runs on EVERY `carbon
// run` / `carbon build`, including the ~10 ms build-cache-hit path. Roadmap
// Layer 0 is explicit that no security mechanism may add cost to the loop a
// developer touches constantly, so paying it every time is out.
//
// So: hash the two files that decide what a correct `node_modules` contains
// (package.json + the lockfile), stamp the hash inside `node_modules` after a
// successful install, and compare on the next run. Two small file reads and a
// sha256 — well under a millisecond — and the spawn only happens when one of
// those files actually changed. Same shape as BuildCache.ts, one layer down.
//
// The stamp lives INSIDE node_modules deliberately: deleting node_modules must
// invalidate it, and `node_modules` is already ignored by every VCS, so the
// stamp is never committed and never travels between machines.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STAMP_FILE = ".carbon-install.json";

/** Lockfile names bun may have written, newest format first. */
const LOCKFILES = ["bun.lock", "bun.lockb"];

interface Stamp {
  key: string;
  installedAt: string;
}

/**
 * sha256 over package.json's and the lockfile's exact bytes. A missing
 * lockfile is folded in as its own distinct state, so a project that gains one
 * (the first `bun install` after scaffolding writes it) re-verifies once.
 */
export function installKey(projectDir: string): string {
  const h = createHash("sha256");
  const pkg = join(projectDir, "package.json");
  h.update("package.json\t");
  h.update(existsSync(pkg) ? readFileSync(pkg) : Buffer.alloc(0));
  h.update("\n");
  for (const name of LOCKFILES) {
    const p = join(projectDir, name);
    if (!existsSync(p)) continue;
    h.update(`${name}\t`);
    h.update(readFileSync(p));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 32);
}

/**
 * True when `node_modules` exists AND was installed from exactly the
 * package.json + lockfile currently on disk. Anything else — no stamp, an
 * unreadable stamp, a stale key — reads as "not verified" and makes the caller
 * install, because being wrong in that direction only costs an install.
 */
export function installIsCurrent(projectDir: string, key: string): boolean {
  const path = join(projectDir, "node_modules", STAMP_FILE);
  if (!existsSync(path)) return false;
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8")) as Stamp;
    return stamp.key === key;
  } catch {
    return false;
  }
}

/**
 * Record that `node_modules` now matches `key`. Best-effort: a read-only or
 * otherwise unwritable `node_modules` costs a re-verification next run, which
 * is not worth failing a build over.
 */
export function writeInstallStamp(projectDir: string, key: string): void {
  const path = join(projectDir, "node_modules", STAMP_FILE);
  const stamp: Stamp = { key, installedAt: new Date().toISOString() };
  try {
    writeFileSync(path, JSON.stringify(stamp, null, 2));
  } catch {
    /* not fatal — see above */
  }
}
