// Auto-provisioning Zig, so `carbon plugin build` / `carbon plugin add`
// never requires a developer — let alone an end user of someone else's
// carbon app — to have installed a compiler themselves.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Observed directly: `carbon plugin add fonts` on a machine with no Zig on
// PATH fails with `'zig' is not recognized as an internal or external
// command`. Every other Carbon toolchain dependency (bun, the Rust runtime
// binary) either ships with the CLI or is something a developer already has
// for other reasons; Zig exists ONLY because Carbon plugins are Zig, and
// "install a compiler just to add one plugin" is real, unacceptable
// friction for the exact audience `carbon plugin add` (as opposed to
// `carbon plugin new`, aimed at plugin AUTHORS) is for.
//
// Zig ships as a single portable archive with no installer and no system
// dependencies — exactly the shape that can be auto-downloaded safely. This
// has no Rust/cargo equivalent for the same reason `ensureRuntime` in
// @carbon/bundling never tries to auto-install cargo: rustup's own bootstrap
// is a much bigger commitment than unzipping one archive.
//
// ── VERSION PINNING ──────────────────────────────────────────────────────────
// One fixed version, not "latest": every first-party plugin's build.zig.zon
// already assumes a specific Zig (minimum_zig_version), and a toolchain that
// silently changes under a plugin author is exactly the kind of drift
// BuildCache/InstallState exist to avoid elsewhere in this same codebase.
// ZIG_VERSION below — verified against https://ziglang.org/download/index.json
// during this session, not assumed — was the latest stable release at the
// time, and the toolchain products/carbon-sdk/fonts was actually built and
// tested against.
//
// ── RESOLUTION ORDER ─────────────────────────────────────────────────────────
//   1. A working `zig` already on PATH — respected and used, so a machine
//      that already has one (a contributor to this repo, a CI image) never
//      pays for a redundant download.
//   2. A previously auto-downloaded copy in the local cache.
//   3. Download + sha256-verify + extract into the cache, then use that.
// Always returns an ABSOLUTE path, never the bare string "zig" — resolving
// once and handing back a string a second PATH lookup could disagree with
// is exactly the class of bug this module exists to close.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "@carbon/logging";
import { run as spawnRun } from "@carbon/process";
import { TOOLS_DIR } from "@carbon/workspace";

const ZIG_VERSION = "0.16.0";

interface ZigTarget {
  readonly tarball: string;
  readonly shasum: string; // sha256, hex
  readonly sizeMB: number; // rounded, for the progress message only
  readonly archive: "zip" | "tar.xz";
}

// Every field below was read from the real index, not guessed — see the
// module doc comment. arm/riscv Linux are omitted: no Carbon plugin build
// target needs them yet, and a real value beats a fabricated one every time
// this table needs to grow.
const TARGETS: Record<string, ZigTarget> = {
  "win32:x64": {
    tarball: "https://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip",
    shasum: "68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e",
    sizeMB: 93,
    archive: "zip",
  },
  "win32:arm64": {
    tarball: "https://ziglang.org/download/0.16.0/zig-aarch64-windows-0.16.0.zip",
    shasum: "aee38316ee4111717900f45dd3130145c39289e105541d737eb8c5ed653c78ef",
    sizeMB: 89,
    archive: "zip",
  },
  "linux:x64": {
    tarball: "https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz",
    shasum: "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
    sizeMB: 53,
    archive: "tar.xz",
  },
  "linux:arm64": {
    tarball: "https://ziglang.org/download/0.16.0/zig-aarch64-linux-0.16.0.tar.xz",
    shasum: "ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17",
    sizeMB: 49,
    archive: "tar.xz",
  },
  "darwin:x64": {
    tarball: "https://ziglang.org/download/0.16.0/zig-x86_64-macos-0.16.0.tar.xz",
    shasum: "0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7",
    sizeMB: 55,
    archive: "tar.xz",
  },
  "darwin:arm64": {
    tarball: "https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz",
    shasum: "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
    sizeMB: 50,
    archive: "tar.xz",
  },
};

/** Where a downloaded toolchain is cached. Never committed — see .gitignore
 *  for `/.tools/orchestration/toolchains/`, mirroring the existing entry for
 *  Cargo's own `/.tools/orchestration/bazel/cargo/target/`. */
const CACHE_ROOT = join(TOOLS_DIR, "orchestration", "toolchains", "zig");

function exeName(): string {
  return process.platform === "win32" ? "zig.exe" : "zig";
}

/**
 * The `tar` to extract with. On Windows this is NOT the bare string "tar":
 * confirmed directly that when a Git-for-Windows / MSYS install puts its own
 * GNU tar ahead of System32 on PATH, GNU tar parses a Windows path's drive
 * letter as a `host:` remote-archive spec (`tar: Cannot connect to C:
 * resolve failed`) — the exact colon GNU tar's own `-f` syntax reserves for
 * `rmt` remote tape devices. Windows 10 1803+ ships a real bsdtar-based
 * tar.exe at System32 that has no such ambiguity and extracts zip AND
 * tar.xz through the same `-xf`; resolving to it explicitly, the same way
 * ensureZig resolves zig itself, sidesteps PATH order entirely rather than
 * hoping a bare "tar" lookup lands on the right one.
 */
function tarExecutable(): string {
  if (process.platform !== "win32") return "tar";
  const sysRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const explicit = join(sysRoot, "System32", "tar.exe");
  return existsSync(explicit) ? explicit : "tar"; // unusual Windows install — best effort
}

/** True if `zig` on PATH actually runs and reports a version — a real
 *  probe, not just "the name resolves", so a stale/broken shim doesn't get
 *  treated as a working install. */
async function systemZigWorks(): Promise<boolean> {
  try {
    const { code } = await spawnRun("zig", ["version"], { stdio: "pipe" });
    return code === 0;
  } catch {
    return false;
  }
}

/** Resolve `zig`'s absolute path from PATH once it's confirmed to work —
 *  `where`/`which` themselves shell out, so this is one extra cheap spawn
 *  rather than trusting a second bare-name lookup to agree with the first. */
async function resolveSystemZigPath(): Promise<string> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { code, stdout } = await spawnRun(finder, ["zig"], { stdio: "pipe" });
    const first = (stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
    if (code === 0 && first) return first.trim();
  } catch {
    /* fall through */
  }
  return "zig"; // confirmed to run; just couldn't recover an absolute path
}

/** Search the extracted tree for the zig executable, up to two levels deep
 *  — the archive's internal top-level folder name isn't assumed (it has
 *  varied across Zig releases). */
function findExe(root: string): string | null {
  if (!existsSync(root)) return null;
  const name = exeName();
  const direct = join(root, name);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(root, entry.name, name);
    if (existsSync(nested)) return nested;
  }
  return null;
}

/**
 * Resolve an absolute path to a working `zig` executable, downloading and
 * caching one if neither PATH nor a prior download has it. Throws with a
 * message naming the manual fallback (install Zig yourself) if this
 * platform has no known download target or the download/verify/extract
 * pipeline fails.
 */
export async function ensureZig(logger: Logger): Promise<string> {
  if (await systemZigWorks()) {
    return resolveSystemZigPath();
  }

  const cached = findExe(join(CACHE_ROOT, ZIG_VERSION));
  if (cached) return cached;

  const key = `${process.platform}:${process.arch}`;
  const target = TARGETS[key];
  if (!target) {
    throw new Error(
      `no Zig ${ZIG_VERSION} build known for ${key} — install Zig yourself and put it on PATH ` +
      `(https://ziglang.org/download/), or extend ZigToolchain.ts's TARGETS table for this platform.`,
    );
  }

  logger.step(`downloading Zig ${ZIG_VERSION} toolchain for ${key} (~${target.sizeMB} MB, one-time)…`);
  mkdirSync(CACHE_ROOT, { recursive: true });
  const downloadPath = join(
    CACHE_ROOT,
    `download-${ZIG_VERSION}-${process.pid}.${target.archive === "zip" ? "zip" : "tar.xz"}`,
  );
  try {
    // Shelled out to curl rather than fetch()+Bun.write: confirmed directly
    // that streaming a ~90 MB response through Bun's fetch/Bun.write in this
    // pipeline stalls indefinitely with zero bytes reaching disk, while curl
    // against the exact same URL completes normally — curl ships on Windows
    // 10+ and virtually every Linux/macOS install by default, so this trades
    // no real portability for a lot of reliability on a path with no
    // interactive way to notice a silent hang.
    const { code: dlCode, stderr: dlErr } = await spawnRun(
      "curl",
      ["-fL", "--retry", "2", "-o", downloadPath, target.tarball],
      { stdio: "pipe" },
    );
    if (dlCode !== 0) {
      throw new Error(`downloading Zig failed (curl exit ${dlCode}): ${dlErr ?? ""}`);
    }

    logger.step(`verifying Zig download (sha256)…`);
    const bytes = await Bun.file(downloadPath).arrayBuffer();
    const actual = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    if (actual !== target.shasum) {
      throw new Error(
        `Zig download failed checksum verification (expected ${target.shasum}, got ${actual}) — refusing to use it.`,
      );
    }

    logger.step(`extracting Zig ${ZIG_VERSION}…`);
    const versionDir = join(CACHE_ROOT, ZIG_VERSION);
    mkdirSync(versionDir, { recursive: true });
    // `tar` for BOTH archive kinds, not PowerShell's Expand-Archive for zip:
    // confirmed directly that Expand-Archive takes several minutes (or
    // longer — the run was killed rather than waited out) on Zig's ~8,000
    // small stdlib files, a known real-world PowerShell performance issue
    // with archives that have many entries, not specific to this download.
    // See tarExecutable()'s own comment for why the executable itself is
    // resolved explicitly rather than trusting a bare "tar" on PATH.
    const { code, stderr } = await spawnRun(tarExecutable(), ["-xf", downloadPath, "-C", versionDir], { stdio: "pipe" });
    if (code !== 0) {
      throw new Error(`extracting Zig ${target.archive === "zip" ? ".zip" : ".tar.xz"} failed (exit ${code}): ${stderr ?? ""}`);
    }

    const exe = findExe(versionDir);
    if (!exe) throw new Error(`Zig extracted to ${versionDir} but no ${exeName()} was found inside it`);
    if (process.platform !== "win32") {
      // tar preserves the archive's own permission bits, which should
      // already be executable — chmod defensively rather than assuming.
      try {
        await spawnRun("chmod", ["+x", exe], { stdio: "ignore" });
      } catch {
        /* best-effort */
      }
    }
    return exe;
  } finally {
    try {
      rmSync(downloadPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
