#!/usr/bin/env bun
// Remove JS build output. `cargo clean` handles the Rust side; this is the
// other half of `just clean`.

import { readdirSync, statSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const TARGETS = new Set(["dist", ".cache", "node_modules"]);
// "bin" is carbon/bin, Cargo's target-dir — it has its own "dist" profile
// output subfolder, which would otherwise match TARGETS below and get wiped
// as if it were generic JS build output.
const SKIP = new Set([".git", "target", "bin", "archive", "Knowledge"]);

let removed = 0;
function walk(dir: string, depth = 0) {
  if (depth > 6) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const abs = join(dir, e);
    let st; try { st = statSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (TARGETS.has(e)) {
      rmSync(abs, { recursive: true, force: true });
      console.log("  removed " + relative(ROOT, abs).replace(/\\/g, "/"));
      removed++;
    } else {
      walk(abs, depth + 1);
    }
  }
}
walk(ROOT);
console.log(removed ? `removed ${removed} directory(ies)` : "nothing to clean");
