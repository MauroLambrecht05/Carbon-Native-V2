// scripts/bench-babel-cache.ts
//
// Measures the per-file Babel cache impact on `carbon build` end-to-end:
//   1. Cold cache, no Babel cache:        rm -rf .carbon-cache + dist
//   2. Warm cache, no edits
//   3. Warm cache, single-file edit (touch a string literal in counter.tsx)
//
// All builds run with --force so the OUTER (build-cache) layer never
// short-circuits us — we want the actual Babel time, not the "cache hit,
// skipping rebuild" path.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI_SRC = join(ROOT, "cli", "src", "index.ts");
const PROJECT = join(ROOT, "examples", "mini-counter");
const COUNTER = join(PROJECT, "counter.tsx");
const CACHE = join(PROJECT, ".carbon-cache");
const DIST = join(PROJECT, "dist");
const BUNDLE = join(DIST, "bundle.js");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

interface BuildResult {
  totalMs: number;
  babelMs: number;
  bunMs: number;
  hits: number;
  misses: number;
}

function parseTimings(stderr: string): { babelMs: number; bunMs: number; hits: number; misses: number } {
  // Match the line: "bun-build+babel: N file(s) transformed in <X> ms babel + <Y> ms bun = <Z> ms total | babel-cache: H hit / M miss (P%)"
  const re = /transformed in (\d+) ms babel \+ (\d+) ms bun.*?babel-cache: (\d+) hit \/ (\d+) miss/;
  const m = stderr.match(re);
  if (!m) return { babelMs: -1, bunMs: -1, hits: -1, misses: -1 };
  return {
    babelMs: Number(m[1]),
    bunMs: Number(m[2]),
    hits: Number(m[3]),
    misses: Number(m[4]),
  };
}

function runBuild(extraArgs: string[] = []): BuildResult {
  const t0 = performance.now();
  const r = spawnSync(
    "bun",
    [CLI_SRC, "build", "--force", ...extraArgs],
    {
      cwd: PROJECT,
      env: { ...process.env, CARBON_BUILD_PROFILE: "1" },
      shell: process.platform === "win32",
    },
  );
  const totalMs = performance.now() - t0;
  if (r.status !== 0) {
    process.stderr.write(r.stderr?.toString() ?? "");
    process.stderr.write(r.stdout?.toString() ?? "");
    throw new Error(`build exit ${r.status}`);
  }
  const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
  const t = parseTimings(out);
  return { totalMs, ...t };
}

function dirSize(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  function walk(d: string) {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else { files++; bytes += st.size; }
    }
  }
  walk(dir);
  return { files, bytes };
}

const N = 3;

function bench(label: string, before: () => void, n = N): BuildResult[] {
  const results: BuildResult[] = [];
  for (let i = 0; i < n; i++) {
    before();
    results.push(runBuild());
  }
  const totals = results.map((r) => r.totalMs);
  const babel = results.map((r) => r.babelMs);
  console.log(
    `[${label}] n=${n} total medians (ms): total=${median(totals).toFixed(0)} babel=${median(babel).toFixed(0)} | hits=${results[results.length - 1].hits} misses=${results[results.length - 1].misses}`,
  );
  for (const r of results) {
    console.log(`    total=${r.totalMs.toFixed(0)}ms babel=${r.babelMs}ms bun=${r.bunMs}ms hits=${r.hits} miss=${r.misses}`);
  }
  return results;
}

console.log(`=== bench-babel-cache (project: ${PROJECT}) ===`);

// Warm-up: ensure node_modules is settled, deps loaded, OS page cache hot.
console.log("\n--- warm-up ---");
for (let i = 0; i < 2; i++) runBuild();

console.log("\n--- 1) Cold cache (no babel cache, fresh build) ---");
const cold = bench("cold", () => {
  rmSync(CACHE, { recursive: true, force: true });
  rmSync(DIST, { recursive: true, force: true });
});

console.log("\n--- 2) Warm cache, no edits ---");
const warm = bench("warm", () => {
  rmSync(DIST, { recursive: true, force: true }); // force bun to rebundle
});

console.log("\n--- 3) Warm cache, single-file edit ---");
const original = readFileSync(COUNTER, "utf8");
let editN = 0;
const single = bench("single-edit", () => {
  rmSync(DIST, { recursive: true, force: true });
  // Touch one line so content hash changes for counter.tsx, every other
  // file's Babel output stays cached.
  const edited = original.replace(/carbon-mini counter/, `carbon-mini counter ${++editN}`);
  writeFileSync(COUNTER, edited);
});
// restore
writeFileSync(COUNTER, original);

const stats = dirSize(join(CACHE, "babel"));
console.log(`\n--- cache size on disk ---`);
console.log(`files=${stats.files} bytes=${stats.bytes} (${(stats.bytes / 1024).toFixed(1)} KB)`);

console.log("\n=== SUMMARY (median ms) ===");
const fmt = (rs: BuildResult[]) => `total=${median(rs.map(r => r.totalMs)).toFixed(0)} babel=${median(rs.map(r => r.babelMs)).toFixed(0)}`;
console.log(`cold        : ${fmt(cold)}`);
console.log(`warm        : ${fmt(warm)}`);
console.log(`single-edit : ${fmt(single)}`);
const lastSingle = single[single.length - 1];
const totalLookups = lastSingle.hits + lastSingle.misses;
const hitRate = totalLookups > 0 ? (lastSingle.hits / totalLookups) * 100 : 0;
console.log(`single-edit cache hit rate: ${hitRate.toFixed(0)}% (${lastSingle.hits} / ${totalLookups})`);
