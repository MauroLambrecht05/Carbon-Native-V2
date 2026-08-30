#!/usr/bin/env bun
// Structural rules that check_workspace.py does not cover.
//
// A directory structure decays unless something rejects the decay. These are
// the rules that, when broken, turn the tree back into a pile of folders — so
// they fail the build instead of being noticed in review six months later.
//
// Run as //.tools/automation/ci:boundaries_test, so `bazel test //...` gates on
// it — see that BUILD file and the checks rule for why it cannot be sandboxed.
//
// ── WHY THIS IS SHORTER THAN V1's ───────────────────────────────────────────
// V1's version had six rules. Two of them are now enforced better elsewhere and
// are deliberately not reimplemented here:
//
//   no-upward-imports    check_workspace.py's "tier direction" and "dependency
//                        direction" checks cover it, and cover more: they know
//                        about contracts/capabilities/infrastructure/
//                        integrations/interface, which V1 had no equivalent of.
//   backend-independence It asserted that carbon/runtime/mini.rs and blitz.rs
//                        never referenced each other. Both are now modules of
//                        one Cargo package with mutually exclusive features
//                        (products/carbon), so Cargo enforces the separation
//                        the rule was approximating.
//
// The four that remain have no other enforcement, and V1 relied on all of them.

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

// Generated, machine-local, or third-party code we carry but do not maintain.
// `.build` is Cargo's output (CARGO_TARGET_DIR), `.local` is the notes/attic
// tree, and bazel-* are the symlinks Bazel drops at the workspace root.
const SKIP_NAMES = new Set([
  ".local", ".build", "node_modules", "target", "dist", ".git", ".claude",
  // .local is CARGO_TARGET_DIR's parent; the bare ".build" above covers any
  // name at any depth, and also any stray one a hand-run cargo leaves behind.
  "bazel-bin", "bazel-out", "bazel-testlogs", "bazel-V2",
  // zig build's own output — every plugin and the SDK package
  // (products/carbon-ext/composition) grows one of each.
  ".zig-cache", "zig-out",
]);
// The vendored rquickjs fork is third-party source, exempt from rules about
// naming and layout. Skipped by exact path so nothing else named "quickjs" is.
const SKIP_PATHS = new Set([
  "solutions/integrations/javascript/quickjs",
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

// ── Rule 1: a package's name matches where it lives ──────────────────────────
// Not cosmetic. @carbon/* specifiers resolve through the path aliases in
// .config/tsconfig.base.json, so a package.json whose name disagrees with its
// alias produces two names for one thing — and the alias is what actually
// resolves, so the wrong one fails silently at publish time rather than loudly
// at build time.
{
  const aliasFile = join(ROOT, ".config", "tsconfig.base.json");
  const aliases: Record<string, string> = {};
  if (existsSync(aliasFile)) {
    const paths = JSON.parse(readFileSync(aliasFile, "utf8")).compilerOptions?.paths ?? {};
    for (const [spec, targets] of Object.entries(paths as Record<string, string[]>)) {
      if (spec.includes("*")) continue;
      // Alias targets are relative to .config/; map back to a repo-relative dir.
      const t = targets[0]!.replace(/^\.\.\//, "");
      aliases[t.split("/").slice(0, -1).join("/")] = spec;
    }
  }
  walk(ROOT, (abs, rel) => {
    if (!rel.endsWith("/package.json")) return;
    const dir = rel.slice(0, -"/package.json".length);
    const want = aliases[dir];
    if (!want) return; // not aliased — nothing to disagree with
    let name: string | undefined;
    try { name = JSON.parse(readFileSync(abs, "utf8")).name; } catch { return; }
    // Examples and labs deliberately use bare names; only check @carbon/* ones.
    if (!name || !name.startsWith("@carbon/")) return;
    if (name !== want) {
      fail("name-matches-dir", `${dir}/package.json is "${name}" but its alias is "${want}"`);
    }
  });
}

// ── Rule 2: one lockfile per ecosystem ───────────────────────────────────────
// Before V1's workspace manifest existed, eleven Cargo.lock files meant eleven
// independent dependency resolutions, eleven copies of every shared dependency,
// and no way to run `cargo test` across the project.
{
  const found: string[] = [];
  walk(ROOT, (_abs, rel) => {
    const base = rel.split("/").pop()!;
    if (base === "Cargo.lock" || base === "bun.lock" || base === "bun.lockb") found.push(rel);
  });
  // A carbon app is its own npm project — `carbon build` runs `bun install` in
  // the app directory to fetch what its package.json declares. So every example
  // grows a bun.lock the moment it is built, and that is correct: the rule
  // below is about THIS repository resolving its dependencies once, not about
  // apps that happen to live inside it. An app is identified by its carbon.toml.
  const isApp = (rel: string) => {
    const dir = rel.split("/").slice(0, -1).join("/");
    return dir !== "" && existsSync(join(ROOT, dir, "carbon.toml"));
  };

  const allowed = new Set([
    // Both manifests live in .config/, so both lockfiles do. Unlike V1, bun.lock
    // is NOT at the root — V2 has no bun workspace, and node_modules is reached
    // through a junction instead. See .config/package.json.
    ".tools/orchestration/bazel/cargo/Cargo.lock",
    ".config/bun.lock",
    // carbon-cli is published as its own npm package, so it resolves its own
    // toolchain dependencies rather than borrowing .config/'s — and a
    // published package that ships no lockfile is a package whose caret ranges
    // re-resolve to whatever was published most recently, every install. That
    // is precisely the supply-chain hole `--frozen-lockfile` exists to close
    // (see .local/notes/roadmap/04-security-and-capabilities), so this
    // lockfile is required, not merely tolerated. It is a second resolution on
    // purpose; the rule above is about accidental ones.
    "products/carbon-cli/bun.lock",
    // Self-contained benchmark harnesses, pinned apart on purpose so a
    // dependency bump in the repo cannot silently move a measurement.
    ".tools/automation/benchmarks/forkbun/bun.lock",
    ".tools/automation/benchmarks/microbench/bun.lock",
    // carbon-gpu-canvas is parked, standalone and deliberately not a member
    // of the shared workspace above — see labs/gpu-canvas/Cargo.toml.
    "labs/gpu-canvas/Cargo.lock",
  ]);
  for (const f of found) {
    if (allowed.has(f) || isApp(f)) continue;
    fail("one-lockfile", `unexpected lockfile: ${f}`);
  }
}

// ── Rule 3: no committed binaries outside the allowlist ──────────────────────
// A .dll test fixture and two .exe tools were once committed with no provenance
// and no way to rebuild them.
{
  const BINARY = [".exe", ".dll", ".so", ".dylib", ".zip", ".lib", ".a"];
  const VENDOR = ".tools/vendor/";
  // Fonts are compiled into the binary and are covered by rule 4 instead.
  const FONT_ASSETS = "solutions/capabilities/text/assets/";
  // Two spots a plugin binary regenerates into, neither meant to be
  // committed (not nested inside a carbon/plugins/local/<name>/ SOURCE tree,
  // which the .zig-cache / zig-out SKIP_NAMES entries already cover):
  //   carbon/native/<os>/<arch>/<name>.<ext>       — carbon/build.zig's
  //     staged output, what SyncPluginsUseCase (@carbon/lifecycle) produces
  //     every `carbon run`/`carbon dev`.
  //   carbon/plugins/vendor/<name>/<crate>.<ext>   — a fetched plugin's raw
  //     binary before staging, written by InstallPluginUseCase /
  //     AddStandardPluginUseCase's auto-heal, same regenerate-on-clone
  //     posture as the staged copy.
  const LOCAL_PLUGIN_ARTIFACT =
    /(^|\/)carbon\/(native\/[^/]+\/[^/]+|plugins\/vendor\/[^/]+)\/[^/]+\.(dll|so|dylib)$/;

  // .tools/vendor/ is the one place a prebuilt binary may live, and only when
  // its SHA-256 is recorded. That makes the exception auditable rather than
  // implicit: an undocumented binary dropped there still fails.
  const checksummed = new Set<string>();
  const sums = join(ROOT, VENDOR, "checksums.txt");
  if (existsSync(sums)) {
    for (const line of readFileSync(sums, "utf8").split("\n")) {
      const m = line.trim().match(/^[a-f0-9]{64}\s+\*?(.+)$/i);
      if (m) checksummed.add(m[1]!.trim());
    }
  }

  walk(ROOT, (_abs, rel) => {
    if (!BINARY.includes(extname(rel))) return;
    if (rel.startsWith(FONT_ASSETS)) return;
    if (LOCAL_PLUGIN_ARTIFACT.test(rel)) return;
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

// ── Rule 4: embedded fonts carry their licenses ──────────────────────────────
// Inter and Roboto are compiled into every binary we ship. Shipping them without
// the license text is a redistribution problem, not a style nit.
{
  const assets = join(ROOT, "solutions", "capabilities", "text", "assets");
  if (existsSync(assets)) {
    const entries = readdirSync(assets);
    const fonts = entries.filter((f) => /\.(ttf|otf|woff2?)$/i.test(f));
    const licenses = entries.filter((f) => /licen[sc]e/i.test(f));
    if (fonts.length && !licenses.length) {
      fail("font-licenses",
           `${fonts.length} font(s) in solutions/capabilities/text/assets/ with no LICENSE file alongside`);
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
console.log(`[OK] Boundaries: naming, lockfiles, committed binaries, font licenses`);
