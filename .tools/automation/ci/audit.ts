#!/usr/bin/env bun
// The JavaScript dependency gate.
//
//   bun .tools/automation/ci/audit.ts
//
// Asks the advisory database about everything in .config/bun.lock and fails
// when a high or critical advisory is not covered by a written exception, or
// when an exception has passed its review date, or covers nothing any more.
// Advisories below the threshold are printed and do not fail.
//
// An exception is a decision somebody made and dated. It lives in
// .config/audit-exceptions.json next to the manifest it is about:
//
//   { "advisory": "GHSA-xxxx-xxxx-xxxx", "package": "name",
//     "reason": "why this does not affect us, or what we are waiting for",
//     "reviewBy": "2027-01-31" }
//
// This is not a Bazel test on purpose. It needs the network and its answer
// changes when the world does, not when the repository does: wired into
// `bazel test //...` it would turn an advisory published overnight into a red
// build on an unrelated change.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Advisory { readonly package: string; readonly id: string; readonly severity: string; readonly title: string; readonly url: string }
export interface Exception { readonly advisory: string; readonly package: string; readonly reason: string; readonly reviewBy: string }
export interface Verdict { readonly blocking: readonly Advisory[]; readonly excepted: readonly Advisory[]; readonly below: readonly Advisory[]; readonly problems: readonly string[] }

const RANK: Record<string, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/;

/** Flattens `bun audit --json`: one entry per advisory, identified by its GHSA ID. */
export function parseAudit(json: unknown): Advisory[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Unexpected audit output");
  const found: Advisory[] = [];
  for (const [name, entries] of Object.entries(json as Record<string, unknown>)) {
    if (!Array.isArray(entries)) throw new Error(`Unexpected audit output for ${name}`);
    for (const entry of entries as Record<string, unknown>[]) {
      const url = String(entry.url ?? ""); const id = GHSA.exec(url)?.[0];
      // An advisory this cannot identify is never silently passed: it is reported under its URL and blocks if severe.
      found.push({ package: name, id: id ?? (url || `unidentified:${String(entry.id)}`), severity: String(entry.severity ?? "critical").toLowerCase(), title: String(entry.title ?? ""), url });
    }
  }
  return found.sort((a, b) => a.package.localeCompare(b.package) || a.id.localeCompare(b.id));
}

export function parseExceptions(json: unknown): Exception[] {
  if (!Array.isArray(json)) throw new Error("audit-exceptions.json must be a list");
  return json.map((entry, index) => {
    const value = entry as Record<string, unknown>;
    for (const key of ["advisory", "package", "reason", "reviewBy"]) if (typeof value?.[key] !== "string" || !(value[key] as string).trim()) throw new Error(`Exception ${index + 1} needs "${key}"`);
    for (const key of Object.keys(value)) if (!["advisory", "package", "reason", "reviewBy"].includes(key)) throw new Error(`Exception ${index + 1} has an unknown field "${key}"`);
    if (!new RegExp(`^${GHSA.source}$`).test(value.advisory as string)) throw new Error(`Exception ${index + 1} must name a GHSA advisory`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.reviewBy as string) || Number.isNaN(Date.parse(`${value.reviewBy}T00:00:00Z`))) throw new Error(`Exception ${index + 1} needs a reviewBy date as YYYY-MM-DD`);
    if ((value.reason as string).trim().length < 20) throw new Error(`Exception ${index + 1} needs a reason somebody could act on`);
    return { advisory: value.advisory as string, package: value.package as string, reason: value.reason as string, reviewBy: value.reviewBy as string };
  });
}

/**
 * Decides what blocks. An exception applies to one advisory in one package, at any severity, until its date.
 * An expired exception, and one that no longer matches anything, are problems in their own right: the first is a
 * decision that was due for another look, the second is a rule left behind after the thing it excused went away.
 */
export function judge(advisories: readonly Advisory[], exceptions: readonly Exception[], today: string, threshold = "high"): Verdict {
  const floor = RANK[threshold]; if (floor === undefined) throw new Error("Unknown severity threshold");
  const blocking: Advisory[] = []; const excepted: Advisory[] = []; const below: Advisory[] = []; const problems: string[] = []; const used = new Set<Exception>();
  for (const advisory of advisories) {
    const exception = exceptions.find(item => item.advisory === advisory.id && item.package === advisory.package);
    if (exception) {
      used.add(exception);
      if (exception.reviewBy < today) { problems.push(`The exception for ${advisory.id} in ${advisory.package} was due for review on ${exception.reviewBy}`); blocking.push(advisory); }
      else excepted.push(advisory);
      continue;
    }
    // A severity this does not know is treated as the worst there is.
    if ((RANK[advisory.severity] ?? RANK.critical!) >= floor) blocking.push(advisory); else below.push(advisory);
  }
  for (const exception of exceptions) if (!used.has(exception)) problems.push(`The exception for ${exception.advisory} in ${exception.package} matches no current advisory; remove it`);
  return { blocking, excepted, below, problems };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "../../.."); const manifest = join(root, ".config");
  const run = Bun.spawnSync([process.execPath, "audit", "--json"], { cwd: manifest, stdout: "pipe", stderr: "pipe" });
  const text = run.stdout.toString().trim();
  let advisories: Advisory[];
  // `bun audit` exits non-zero when it finds anything, so the exit code says nothing here: the output must parse.
  try { advisories = parseAudit(text ? JSON.parse(text.slice(text.indexOf("{"))) : {}); }
  catch { console.error(`[audit] could not read the audit result\n${run.stderr.toString().slice(0, 2000)}`); process.exit(2); }
  const verdict = judge(advisories, parseExceptions(JSON.parse(readFileSync(join(manifest, "audit-exceptions.json"), "utf8"))), new Date().toISOString().slice(0, 10));
  const line = (advisory: Advisory) => `  ${advisory.severity.padEnd(8)} ${advisory.package}  ${advisory.id}  ${advisory.title}`;
  if (verdict.below.length) console.log(`[audit] below the threshold, not blocking:\n${verdict.below.map(line).join("\n")}`);
  if (verdict.excepted.length) console.log(`[audit] covered by a dated exception:\n${verdict.excepted.map(line).join("\n")}`);
  for (const problem of verdict.problems) console.error(`[audit] ${problem}`);
  if (verdict.blocking.length) console.error(`[audit] blocking:\n${verdict.blocking.map(line).join("\n")}`);
  if (verdict.blocking.length || verdict.problems.length) process.exit(1);
  console.log(`[audit] ${advisories.length} advisories, none blocking`);
}
