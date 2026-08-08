#!/usr/bin/env bun
// Enforces the structural rules the layout depends on.
//
// A directory structure decays unless something rejects the decay. These are
// the rules that, when broken, turn the tree back into a pile of folders — so
// they fail the build instead of being noticed in review six months later.
//
// Run with `just check-boundaries`. Every violation is reported before exiting,
// so one run tells you everything that needs fixing.

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
// `.local/` holds everything generated or machine-local — notes, archive.
// `carbon/bin` is Cargo's own build output (target-dir in .cargo/config.toml),
// nested inside the carbon/ source tree but still generated, not source.
// Neither is subject to these rules.
const SKIP_NAMES = new Set([
  ".local", "node_modules", "target", "dist", ".git", ".claude", "bin",
]);
// "vendor" means two different things in this tree — shared/vendor is our
// own vite/babel source (must be scanned by rules 1 and 3 below) and
// tools/vendor is prebuilt binaries (must be scanned by rule 5, which checks
// their checksums). Neither should be skipped by bare name. Only the
// rquickjs-core fork is truly third-party code we carry but don't maintain —
// skip that one by exact path instead, so it doesn't pollute rule 2's
// backend-independence check with code we didn't write.
const SKIP_PATHS = new Set([
  "shared/vendor/rquickjs-core",
]);

const violations: string[] = [];
const fail = (rule: string, detail: string) => violations.push(`  [${rule}] ${detail}`);

function walk(dir: string, onFile: (abs: string, rel: string) => void) {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP_NAMES.has(e)) continue;
    const abs = join(dir, e);
    const rel = relative(ROOT, abs).split(sep).join("/");
    if (SKIP_PATHS.has(rel)) continue;
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, onFile);
    else onFile(abs, rel);
  }
}

const sourceFiles: { abs: string; rel: string; text: string }[] = [];
walk(ROOT, (abs, rel) => {
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".rs"].includes(extname(abs))) return;
  if (rel.endsWith(".d.ts")) return;
  try { sourceFiles.push({ abs, rel, text: readFileSync(abs, "utf8") }); } catch {}
});

// ── Rule 1: no upward imports ────────────────────────────────────────────────
// Code that ships inside an app must never depend on the tooling that builds
// it. If stdlib imports from tooling, the build tool ends up in the user's
// binary — and the dependency is invisible until someone tries to ship.
{
  const FORBIDDEN: Array<[from: string, to: string, why: string]> = [
    ["ecosystem/system/stdlib/", "@carbon/cli", "shipped code must not import the CLI"],
    ["ecosystem/system/stdlib/", "@carbon/vite-", "shipped code must not import build plugins"],
    ["ecosystem/system/stdlib/", "@carbon/babel", "shipped code must not import build transforms"],
    ["ecosystem/system/stdlib/", "@carbon/testing", "shipped code must not import test helpers"],
    ["carbon/", "@carbon/cli", "a runtime must not import the CLI"],
    ["ecosystem/users/sdk/", "@carbon/cli", "the plugin sdk must not import the CLI"],
    ["ecosystem/system/clipboard/", "@carbon/cli", "a plugin must not import the CLI"],
    ["shared/logic/ts/", "@carbon/cli", "shared must not depend on its consumers"],
    ["shared/logic/ts/", "@carbon/vite-", "shared must not depend on its consumers"],
  ];
  for (const { rel, text } of sourceFiles) {
    if (rel.includes("/test/") || rel.includes("/tests/")) continue;
    for (const [from, to, why] of FORBIDDEN) {
      if (!rel.startsWith(from)) continue;
      if (text.includes(`"${to}`) || text.includes(`'${to}`)) {
        fail("no-upward-imports", `${rel} imports ${to} — ${why}`);
      }
    }
  }
}

// ── Rule 2: backends stay independent ────────────────────────────────────────
// carbon-mini-blitz used to `#[path]`-include four modules straight out of
// carbon-mini's src/, which made an experimental backend a build-time
// dependency of the primary one. Shared code that isn't rendering-specific
// lives in carbon/host/ (OS capability bridge) or carbon/api/ (plugin ABI).
//
// mini and blitz are now two `[[bin]]` targets (mini.rs, blitz.rs) in one
// Cargo package (carbon/runtime/Cargo.toml) rather than two crates in their
// own directories, so there's no directory prefix left to detect backends
// by. Both are hardcoded here instead — there are exactly two, and a third
// backend is rare enough that adding one line here when it happens is fine.
{
  const backends = [
    { name: "mini", file: "carbon/runtime/mini.rs" },
    { name: "blitz", file: "carbon/runtime/blitz.rs" },
  ];
  for (const { rel, text } of sourceFiles) {
    const mine = backends.find((b) => b.file === rel);
    if (!mine) continue;
    for (const other of backends) {
      if (other.name === mine.name) continue;
      // mini.rs and blitz.rs are siblings in the same directory and share
      // mod.rs (see carbon/runtime/mod.rs) — the one thing they must NOT do
      // is #[path]/mod-include each other directly.
      const otherFileName = other.file.split("/").pop()!;
      if (text.includes(otherFileName)) {
        fail("backend-independence",
             `${mine.file} references ${otherFileName} — put shared code in carbon/runtime/mod.rs, carbon/host/, or carbon/api/`);
      }
    }
  }
}

// ── Rule 3: directory name == artifact name ──────────────────────────────────
// You should be able to find a package by the name it publishes under. Six
// packages violated this before the migration (packages/carbon-fast-import
// published carbon-vite-plugin-fast-import, and so on).
{
  const expected = (rel: string): string | null => {
    const p = rel.split("/");
    if (p[0] === "ecosystem" && p[1] === "system" && p[2] === "stdlib" && p[3] === "compat")
      return `@carbon/compat-${p[4]}`;
    if (p[0] === "ecosystem" && p[1] === "system" && p[2] === "stdlib") return `@carbon/${p[3]}`;
    if (p[0] === "shared" && p[1] === "vendor" && p[2] === "vite") return `@carbon/vite-${p[3]}`;
    if (p[0] === "shared" && p[1] === "vendor" && p[2] === "babel") return "@carbon/babel";
    if (p[0] === "tools" && p[1] === "editor") return null; // ts-plugin, vscode
    if (p[0] === "tools" && p[1] === "scripts") return null; // bench harnesses
    if (p[0] === "tools") return `@carbon/${p[1]}`;
    // carbon/runtime/engine/paint/renderers/<pkg> — react/solid target mini's
    // scene graph specifically (the only backend rendering through
    // react-reconciler-style adapters today); npm names stay @carbon/mini-<pkg>
    // even though the renderers live under paint/ (the rendering engine they
    // paint through), not under a directory named "mini".
    if (p[0] === "carbon" && p[1] === "runtime" && p[2] === "engine" && p[3] === "paint" && p[4] === "renderers")
      return `@carbon/mini-${p[5]}`;
    // carbon/runtime/bindings — wraps generic host native calls, not
    // backend-specific, so it isn't nested under any one engine/<name>/.
    if (p[0] === "carbon" && p[1] === "runtime" && p[2] === "bindings" && p.length === 3)
      return "@carbon/runtime-bindings";
    return null;
  };
  walk(ROOT, (abs, rel) => {
    if (!rel.endsWith("package.json")) return;
    const dir = rel.slice(0, -"/package.json".length);
    const want = expected(dir);
    if (!want) return;
    let name: string;
    try { name = JSON.parse(readFileSync(abs, "utf8")).name; } catch { return; }
    if (name !== want) {
      fail("name-matches-dir", `${dir}/package.json is "${name}", expected "${want}"`);
    }
  });

  walk(join(ROOT, "carbon", "runtime", "engine"), (abs, rel) => {
    if (!rel.endsWith("Cargo.toml") || rel.includes("vendor")) return;
    const m = readFileSync(abs, "utf8").match(/^name = "([^"]+)"/m);
    const dir = rel.split("/");
    // carbon/runtime/engine/<name>/native/Cargo.toml — image/Cargo.toml has no
    // native/ nesting, so dir[4] !== "native" and it's naturally excluded.
    if (m && dir[4] === "native" && !m[1]!.includes(dir[3]!)) {
      fail("name-matches-dir",
           `${rel} is crate "${m[1]}" but lives in carbon/runtime/engine/${dir[3]}/`);
    }
  });
}

// ── Rule 4: one lockfile per ecosystem ───────────────────────────────────────
// Eleven Cargo.lock files meant eleven independent dependency resolutions and
// no way to run cargo test across the project.
{
  const found: string[] = [];
  walk(ROOT, (_abs, rel) => {
    const base = rel.split("/").pop()!;
    if (base === "Cargo.lock" || base === "bun.lock") found.push(rel);
  });
  const allowed = new Set([
    // The Rust workspace manifest lives in .config/rust/, so its lockfile does
    // too. bun.lock must stay at the root — Bun cannot resolve an out-of-root
    // workspace root. See .config/README.md.
    ".config/rust/Cargo.lock",
    "bun.lock",
    // Self-contained benchmark harnesses, deliberately pinned apart so a
    // dependency bump in the repo can't silently move a measurement.
    "tools/scripts/benchmarks/forkbun/bun.lock",
    "tools/scripts/benchmarks/microbench/bun.lock",
  ]);
  for (const f of found) {
    if (!allowed.has(f)) fail("one-lockfile", `unexpected lockfile: ${f}`);
  }
}

// ── Rule 5: no committed binaries outside the allowlist ──────────────────────
// A .dll test fixture and two .exe tools were committed before the migration,
// with no provenance and no way to rebuild them.
{
  const BINARY = [".exe", ".dll", ".so", ".dylib", ".zip", ".tar.gz", ".lib", ".a"];
  const VENDOR = "tools/vendor/";

  // tools/vendor/ is the one place a prebuilt binary may live, and only when
  // its SHA-256 is recorded. That makes the exception auditable instead of
  // implicit: an undocumented binary dropped there still fails.
  let checksummed = new Set<string>();
  const sums = join(ROOT, VENDOR, "checksums.txt");
  if (existsSync(sums)) {
    for (const line of readFileSync(sums, "utf8").split("\n")) {
      const m = line.trim().match(/^[a-f0-9]{64}\s+\*?(.+)$/i);
      if (m) checksummed.add(m[1].trim());
    }
  }

  walk(ROOT, (_abs, rel) => {
    if (!BINARY.includes(extname(rel))) return;
    if (rel.startsWith("carbon/runtime/engine/text-renderer/assets/")) return; // embedded fonts
    if (rel.startsWith(VENDOR)) {
      const base = rel.slice(VENDOR.length);
      if (!checksummed.has(base)) {
        fail("no-committed-binaries",
             `${rel} is not listed in ${VENDOR}checksums.txt — vendored binaries must be checksummed`);
      }
      return;
    }
    fail("no-committed-binaries", `${rel} — build it in CI, or vendor it in ${VENDOR} with a checksum`);
  });
}

// ── Rule 6: embedded fonts carry their licenses ──────────────────────────────
// Inter and Roboto are compiled into every binary we ship. Shipping them
// without the license text is a redistribution problem, not a style nit.
{
  const assets = join(ROOT, "carbon/runtime/engine/text-renderer/assets");
  if (existsSync(assets)) {
    const fonts = readdirSync(assets).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f));
    const licenses = readdirSync(assets).filter((f) => /licen[sc]e/i.test(f));
    if (fonts.length && !licenses.length) {
      fail("font-licenses",
           `${fonts.length} font(s) in carbon/runtime/engine/text-renderer/assets/ with no LICENSE file alongside`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (violations.length) {
  console.error(`\nboundary check failed — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(v);
  console.error("\nThese rules are documented in CONTRIBUTING.md.\n");
  process.exit(1);
}
console.log(`boundary check passed (${sourceFiles.length} source files scanned)`);
