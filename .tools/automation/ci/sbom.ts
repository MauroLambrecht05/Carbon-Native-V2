#!/usr/bin/env bun
// Software bill of materials for the whole repository, in CycloneDX 1.5 JSON.
//
//   bun .tools/automation/ci/sbom.ts <output.json>
//
// It lists every package the two lockfiles pin: .config/bun.lock for
// JavaScript and .tools/orchestration/bazel/cargo/Cargo.lock for Rust. Each
// component carries its exact version, a package URL, and the digest the
// lockfile records, so a consumer can check what they received against it.
//
// The output is a function of the lockfiles alone: the same lockfiles give
// the same bytes, with no timestamp and a serial number derived from the
// content. A bill of materials that changes on every run cannot be compared.
//
// What it does not list: the toolchains themselves (bun, rustc, zig) and the
// operating-system packages of the container images. Those are pinned in
// MODULE.bazel and the Dockerfiles.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Component { readonly type: "library"; readonly name: string; readonly version: string; readonly purl: string; readonly "bom-ref": string; readonly hashes?: readonly { readonly alg: string; readonly content: string }[] }

/** bun.lock is JSON with trailing commas. Strings are respected, so a comma inside one is never touched. */
function parseLockJson(text: string): any {
  let out = ""; let inString = false; let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) { out += char; if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') { inString = true; out += char; continue; }
    if (char === ",") { let next = index + 1; while (next < text.length && /\s/.test(text[next]!)) next++; if (text[next] === "}" || text[next] === "]") continue; }
    out += char;
  }
  return JSON.parse(out);
}

const ALGORITHMS: Record<string, string> = { sha512: "SHA-512", sha256: "SHA-256", sha1: "SHA-1" };

/** Every package bun.lock pins. An entry is `[ "name@version", registry, metadata, integrity ]`. */
export function npmComponents(lockText: string): Component[] {
  const lock = parseLockJson(lockText); const seen = new Map<string, Component>();
  for (const entry of Object.values(lock.packages ?? {}) as unknown[][]) {
    const spec = String(entry[0]); const at = spec.lastIndexOf("@"); if (at <= 0) continue;
    const name = spec.slice(0, at); const version = spec.slice(at + 1);
    // A workspace or a local link is this repository's own code, not something it received.
    if (!/^\d/.test(version)) continue;
    const purl = `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
    const integrity = [...entry].reverse().find(value => typeof value === "string" && /^sha(1|256|512)-/.test(value)) as string | undefined;
    const dash = integrity?.indexOf("-") ?? -1;
    const hashes = integrity ? [{ alg: ALGORITHMS[integrity.slice(0, dash)]!, content: Buffer.from(integrity.slice(dash + 1), "base64").toString("hex") }] : undefined;
    seen.set(purl, { type: "library", name, version, purl, "bom-ref": purl, ...(hashes ? { hashes } : {}) });
  }
  return [...seen.values()];
}

/** Every crate Cargo.lock pins from a registry. Workspace members have no source and are left out. */
export function cargoComponents(lockText: string): Component[] {
  const seen = new Map<string, Component>();
  for (const block of lockText.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (key: string) => new RegExp(`^${key} = "([^"]*)"`, "m").exec(block)?.[1];
    const name = field("name"); const version = field("version"); const source = field("source"); const checksum = field("checksum");
    if (!name || !version || !source) continue;
    const purl = `pkg:cargo/${name}@${version}`;
    seen.set(purl, { type: "library", name, version, purl, "bom-ref": purl, ...(checksum ? { hashes: [{ alg: "SHA-256", content: checksum }] } : {}) });
  }
  return [...seen.values()];
}

/** The document. Components are sorted, and the serial number is derived from them, so equal inputs give equal bytes. */
export function billOfMaterials(components: readonly Component[]): string {
  const sorted = [...components].sort((a, b) => a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  const serial = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: serial, version: 1,
    metadata: { component: { type: "application", name: "carbon-native", "bom-ref": "carbon-native" }, tools: [{ name: "carbon sbom", vendor: "carbon-native" }] }, components: sorted }, null, 2) + "\n";
}

if (import.meta.main) {
  const root = join(import.meta.dir, "../../.."); const output = process.argv[2];
  if (!output) { console.error("usage: sbom.ts <output.json>"); process.exit(2); }
  const npm = npmComponents(readFileSync(join(root, ".config/bun.lock"), "utf8"));
  const cargo = cargoComponents(readFileSync(join(root, ".tools/orchestration/bazel/cargo/Cargo.lock"), "utf8"));
  // An empty half means a lockfile moved or changed shape, not that the repository has no dependencies.
  if (!npm.length || !cargo.length) { console.error(`[sbom] found ${npm.length} npm and ${cargo.length} cargo packages; refusing to write a partial bill of materials`); process.exit(1); }
  writeFileSync(output, billOfMaterials([...npm, ...cargo]));
  console.log(`[sbom] ${npm.length} npm and ${cargo.length} cargo packages -> ${output}`);
}
