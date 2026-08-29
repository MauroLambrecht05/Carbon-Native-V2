/**
 * CI / Build Extractor
 *
 * Handles:
 *   - GitHub Actions workflows (.github/workflows/*.yml)
 *   - Bazel BUILD.bazel and MODULE.bazel files
 *   - Cargo.toml manifests
 *   - package.json manifests
 *   - Docker and docker-compose files
 *   - Shell scripts and PowerShell scripts (key commands)
 */

import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "smol-toml"; // For TOML — re-used below
import { basename, dirname, join } from "path";
import type {
  RawCiWorkflow,
  RawCiJob,
  RawCiStep,
  RawBuildTarget,
  RawCargoManifest,
  RawNpmManifest,
  RawFileExtraction,
  SourceEvidence,
  Language,
} from "../stages/types.ts";

// ─── YAML parsing (no dep — we have smol-toml, use simple regex for YAML) ─────
// For GitHub Actions YAML, we use a simple line-based parser rather than
// a full YAML library, since the dep budget is minimal.

interface YamlNode {
  [key: string]: YamlNode | string | string[] | YamlNode[] | unknown;
}

function parseSimpleYaml(content: string): YamlNode {
  // Use JSON.parse on JSON parts, otherwise use simple indent parser
  // For our needs (CI files), the key structures are predictable enough
  // to parse with a lightweight approach.
  try {
    // Attempt to use bun's built-in YAML if available
    // Falls back to regex-based extraction
    return parseYamlLines(content);
  } catch {
    return {};
  }
}

function parseYamlLines(content: string): YamlNode {
  const result: YamlNode = {};
  const lines = content.split("\n");
  const stack: Array<{ indent: number; obj: YamlNode | YamlNode[] }> = [{ indent: -1, obj: result }];

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.replace(/\s*#.*$/, "").trim(); // strip comments
    i++;

    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = rawLine.search(/\S/);
    if (indent < 0) continue;

    // Pop stack to correct indent level
    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? 0) >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]?.obj;

    const kvMatch = trimmed.match(/^([\w\-_.]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const val = kvMatch[2]!.trim();

      if (!val || val === "|" || val === ">") {
        // Object or block scalar — collect following indented lines as string
        const childObj: YamlNode = {};
        if (!Array.isArray(parent)) {
          (parent as YamlNode)[key] = childObj;
          stack.push({ indent, obj: childObj });
        }
      } else if (val.startsWith("[")) {
        // Inline array
        try {
          const arr = JSON.parse(val.replace(/'/g, '"'));
          if (!Array.isArray(parent)) (parent as YamlNode)[key] = arr;
        } catch {
          if (!Array.isArray(parent)) (parent as YamlNode)[key] = val;
        }
      } else {
        // Simple value — strip quotes
        const cleanVal = val.replace(/^['"]|['"]$/g, "");
        if (!Array.isArray(parent)) (parent as YamlNode)[key] = cleanVal;
      }
    } else if (trimmed.startsWith("- ")) {
      // Array item
      const val = trimmed.slice(2).trim();
      const parentNode = stack[stack.length - 1]?.obj;
      if (Array.isArray(parentNode)) {
        parentNode.push(val);
      }
    }
  }

  return result;
}

// ─── GitHub Actions ───────────────────────────────────────────────────────────

export function extractCiWorkflow(filePath: string, relPath: string): RawCiWorkflow {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  // Extract with regex for the key structures we care about
  const name = content.match(/^name:\s*(.+)/m)?.[1]?.trim() ?? basename(filePath, ".yml");

  // Triggers
  const triggers: string[] = [];
  const onSection = content.match(/^on:\n((?:\s+.+\n?)*)/m)?.[1] ?? "";
  for (const match of onSection.matchAll(/^\s{2,4}([\w_]+):/gm)) {
    triggers.push(match[1]!);
  }
  if (content.match(/^on:\s+push$/m)) triggers.push("push");
  if (content.match(/^on:\s+pull_request$/m)) triggers.push("pull_request");
  if (content.match(/push:/)) triggers.includes("push") || triggers.push("push");
  if (content.match(/pull_request:/)) triggers.includes("pull_request") || triggers.push("pull_request");
  if (content.match(/tags:/)) triggers.includes("tags") || triggers.push("tags");
  if (content.match(/workflow_dispatch:/)) triggers.includes("workflow_dispatch") || triggers.push("workflow_dispatch");
  if (content.match(/workflow_run:/)) triggers.includes("workflow_run") || triggers.push("workflow_run");

  // Jobs — parse each job block
  const jobs: RawCiJob[] = [];
  const jobsSection = content.match(/^jobs:\n([\s\S]+?)(?=^\w|\Z)/m);
  if (jobsSection) {
    // Find job IDs
    const jobIdMatches = [...content.matchAll(/^  ([\w-]+):\n\s+name:/gm)];
    const jobIds = [...content.matchAll(/^  ([\w-]+):\n(?:\s+(?:name|runs-on|needs|strategy|steps):)/gm)];

    for (const jobMatch of jobIds) {
      const jobId = jobMatch[1]!;
      // Extract job block
      const jobStart = content.indexOf(`  ${jobId}:\n`);
      if (jobStart < 0) continue;

      const jobName = content.slice(jobStart).match(/name:\s*(.+)/)?.[1]?.trim() ?? jobId;
      const runsOn  = content.slice(jobStart, jobStart + 500).match(/runs-on:\s*(.+)/)?.[1]?.trim() ?? "unknown";
      const needs   = content.slice(jobStart, jobStart + 500).match(/needs:\s*\[([^\]]+)\]/)?.[1]?.split(",").map(s => s.trim().replace(/'/g, "")) ?? [];
      const cond    = content.slice(jobStart, jobStart + 500).match(/if:\s*(.+)/)?.[1]?.trim();

      // Extract steps
      const steps: RawCiStep[] = [];
      // Find the steps: block for this job
      let stepsStart = jobStart;
      const stepsMatch = content.slice(jobStart, jobStart + 10000).match(/\n    steps:\n([\s\S]+?)(?=\n    \w|\n  \w|$)/);
      if (stepsMatch) {
        const stepsContent = stepsMatch[1]!;
        // Each step starts with "      - " or "    - "
        const stepBlocks = stepsContent.split(/\n      - name:|\n    - name:/);
        for (const block of stepBlocks) {
          if (!block.trim()) continue;
          const stepName = block.match(/^(.+?)(?:\n|$)/)?.[1]?.trim() ?? block.slice(0, 50).trim();
          const run      = block.match(/run:\s*\|?\n((?:\s{8,}.+\n?)*)/)?.[1]?.trim() ||
                           block.match(/run:\s*>?\n?((?:\s{8,}.+\n?)+)/)?.[1]?.trim() ||
                           block.match(/run:\s*(.+)/)?.[1]?.trim();
          const uses     = block.match(/uses:\s*(.+)/)?.[1]?.trim();
          const stepCond = block.match(/if:\s*(.+)/)?.[1]?.trim();

          if (stepName) {
            steps.push({ name: stepName, run, uses, condition: stepCond });
          }
        }
      }

      jobs.push({ id: jobId, name: jobName, runsOn, needs, condition: cond, steps });
    }
  }

  // Global env
  const envSection = content.match(/^env:\n((?:\s{2}.+\n?)*)/m)?.[1] ?? "";
  const env: Record<string, string> = {};
  for (const m of envSection.matchAll(/^\s{2}([\w_]+):\s*(.+)/gm)) {
    env[m[1]!] = m[2]!.trim();
  }

  return { file: relPath, name, triggers, jobs, env };
}

// ─── Cargo.toml ───────────────────────────────────────────────────────────────

export function extractCargoManifest(filePath: string, relPath: string): RawCargoManifest | null {
  let source: string;
  try { source = readFileSync(filePath, "utf8"); } catch { return null; }

  let parsed: Record<string, unknown>;
  try { parsed = parseYaml(source) as Record<string, unknown>; } catch { return null; }

  const pkg = (parsed["package"] ?? {}) as Record<string, unknown>;
  const name = (pkg["name"] ?? "") as string;
  if (!name) return null;

  const features: Record<string, string[]> = {};
  const rawFeatures = (parsed["features"] ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawFeatures)) {
    features[k] = Array.isArray(v) ? v.map(String) : [];
  }

  const deps: Record<string, { version?: string; path?: string; optional?: boolean; features?: string[] }> = {};
  const rawDeps = (parsed["dependencies"] ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawDeps)) {
    if (typeof v === "string") {
      deps[k] = { version: v };
    } else if (typeof v === "object" && v !== null) {
      const d = v as Record<string, unknown>;
      deps[k] = {
        version:  d["version"] as string | undefined,
        path:     d["path"]    as string | undefined,
        optional: d["optional"] as boolean | undefined,
        features: Array.isArray(d["features"]) ? d["features"].map(String) : undefined,
      };
    }
  }

  const bins: RawCargoManifest["bins"] = [];
  const rawBins = parsed["bin"];
  if (Array.isArray(rawBins)) {
    for (const b of rawBins) {
      const bd = b as Record<string, unknown>;
      bins.push({
        name: String(bd["name"] ?? ""),
        path: String(bd["path"] ?? ""),
        requiredFeatures: Array.isArray(bd["required-features"])
          ? bd["required-features"].map(String)
          : undefined,
      });
    }
  }

  const libs: RawCargoManifest["libs"] = [];
  const rawLib = parsed["lib"];
  if (rawLib && typeof rawLib === "object") {
    const ld = rawLib as Record<string, unknown>;
    libs.push({ name: String(ld["name"] ?? name), path: ld["path"] as string | undefined });
  }

  return {
    file: relPath,
    packageName: name,
    version:  String(pkg["version"] ?? ""),
    edition:  String(pkg["edition"] ?? ""),
    bins,
    libs,
    features,
    dependencies: deps,
  };
}

// ─── package.json ─────────────────────────────────────────────────────────────

export function extractNpmManifest(filePath: string, relPath: string): RawNpmManifest | null {
  let source: string;
  try { source = readFileSync(filePath, "utf8"); } catch { return null; }

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(source); } catch { return null; }

  const name = parsed["name"] as string | undefined;
  if (!name) return null;

  return {
    file: relPath,
    name,
    version:         parsed["version"] as string | undefined,
    description:     parsed["description"] as string | undefined,
    scripts:         (parsed["scripts"] as Record<string, string> | undefined) ?? {},
    dependencies:    (parsed["dependencies"] as Record<string, string> | undefined) ?? {},
    devDependencies: (parsed["devDependencies"] as Record<string, string> | undefined) ?? {},
  };
}

// ─── Bazel BUILD ──────────────────────────────────────────────────────────────

export function extractBazelBuild(filePath: string, relPath: string): RawBuildTarget[] {
  let source: string;
  try { source = readFileSync(filePath, "utf8"); } catch { return []; }

  const targets: RawBuildTarget[] = [];

  // Match rule invocations: rule_name(name = "...", ...)
  const ruleRe = /(\w+)\s*\(\s*\n?\s*name\s*=\s*"([^"]+)"/g;
  for (const m of source.matchAll(ruleRe)) {
    const ruleName = m[1]!.toLowerCase();
    const targetName = m[2]!;

    let kind: RawBuildTarget["kind"] = "library";
    let language: Language = "unknown";

    if (ruleName.includes("binary") || ruleName.includes("bin")) { kind = "binary"; }
    else if (ruleName.includes("test")) { kind = "test"; }
    else if (ruleName.includes("bundle")) { kind = "bundle"; }
    else if (ruleName.includes("container") || ruleName.includes("image")) { kind = "container"; }

    if (ruleName.startsWith("rust") || ruleName.startsWith("cargo")) language = "rust";
    else if (ruleName.startsWith("bun") || ruleName.startsWith("ts") || ruleName.startsWith("js")) language = "typescript";
    else if (ruleName.startsWith("cc") || ruleName.startsWith("cpp")) language = "cpp";
    else if (ruleName.startsWith("go")) language = "go";
    else if (ruleName.startsWith("py")) language = "python";

    targets.push({ name: targetName, kind, language, file: relPath });
  }

  return targets;
}

// ─── Docker ───────────────────────────────────────────────────────────────────

export function extractDockerfile(filePath: string, relPath: string): RawFileExtraction {
  const result: RawFileExtraction = {
    file: relPath,
    language: "dockerfile",
    symbols: [],
    conditions: [],
    dependencies: [],
    errors: [],
    validations: [],
    configAccesses: [],
    externalCalls: [],
    comments: [],
    extractionErrors: [],
  };

  let source: string;
  try { source = readFileSync(filePath, "utf8"); } catch { return result; }

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    const lineNum = i + 1;

    if (line.startsWith("FROM ")) {
      const image = line.slice(5).trim();
      result.externalCalls.push({
        target: image,
        kind: "network",
        evidence: { file: relPath, lineStart: lineNum, extractedBy: "ci-build-extractor" },
      });
    }

    if (line.startsWith("ENV ")) {
      const parts = line.slice(4).trim().split(/\s+|=/);
      if (parts[0]) {
        result.configAccesses.push({
          key: parts[0],
          kind: "write",
          defaultValue: parts[1],
          evidence: { file: relPath, lineStart: lineNum, extractedBy: "ci-build-extractor" },
        });
      }
    }

    if (line.startsWith("ARG ")) {
      const argName = line.slice(4).trim().split(/=|$/)[0]?.trim();
      if (argName) {
        result.configAccesses.push({
          key: argName,
          kind: "read",
          evidence: { file: relPath, lineStart: lineNum, extractedBy: "ci-build-extractor" },
        });
      }
    }

    if (line.startsWith("EXPOSE ")) {
      const port = line.slice(7).trim();
      result.externalCalls.push({
        target: `port ${port}`,
        kind: "network",
        evidence: { file: relPath, lineStart: lineNum, extractedBy: "ci-build-extractor" },
      });
    }

    if (line.startsWith("#")) {
      const comment = line.slice(1).trim();
      if (comment.length > 10) result.comments.push(comment);
    }
  }

  return result;
}

// ─── Shell / PowerShell ───────────────────────────────────────────────────────

export function extractShellScript(filePath: string, relPath: string): RawFileExtraction {
  const result: RawFileExtraction = {
    file: relPath,
    language: filePath.endsWith(".ps1") ? "powershell" : "shell",
    symbols: [],
    conditions: [],
    dependencies: [],
    errors: [],
    validations: [],
    configAccesses: [],
    externalCalls: [],
    comments: [],
    extractionErrors: [],
  };

  let source: string;
  try { source = readFileSync(filePath, "utf8"); } catch { return result; }

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    const lineNum = i + 1;

    // Conditionals
    if (line.match(/^if\s+\[/) || line.match(/^if\s+"/) || line.match(/^If\s+\(/)) {
      const condition = line.replace(/^if\s+/i, "").replace(/;\s*then$/, "").trim();
      result.conditions.push({
        condition,
        trueAction: "execute block",
        context: basename(relPath),
        evidence: { file: relPath, lineStart: lineNum, extractedBy: "ci-build-extractor" },
      });
    }

    // Environment variable accesses
    for (const envM of line.matchAll(/\$(?:env:)?([A-Z_][A-Z0-9_]{2,})/g)) {
      result.configAccesses.push({
        key: envM[1]!,
        kind: "read",
        evidence: { file: relPath, lineStart: lineNum, extractedBy: "ci-build-extractor" },
      });
    }

    // bazel calls
    if (line.includes("bazel ")) {
      const target = line.match(/bazel\s+(?:build|run|test)\s+(\/\/[^\s]+)/)?.[1];
      result.externalCalls.push({
        target: target ?? "bazel",
        kind: "process",
        evidence: { file: relPath, lineStart: lineNum, extractedBy: "ci-build-extractor" },
      } as any);
    }

    // Comments
    if (line.startsWith("#") || line.startsWith("//")) {
      const comment = line.replace(/^[#/]+\s*/, "");
      if (comment.length > 10) result.comments.push(comment);
    }
  }

  return result;
}

// ─── FlatBuffers ──────────────────────────────────────────────────────────────

import type { RawFlatbuffersSchema } from "../stages/types.ts";

export function extractFlatbuffers(filePath: string, relPath: string): RawFlatbuffersSchema {
  let source: string;
  try { source = readFileSync(filePath, "utf8"); } catch {
    return { file: relPath, tables: [], enums: [], unions: [], structs: [], rpcs: [] };
  }

  const namespace = source.match(/namespace\s+([\w.]+);/)?.[1];
  const tables  = [...source.matchAll(/\btable\s+(\w+)\s*\{/g)].map(m => m[1]!);
  const enums   = [...source.matchAll(/\benum\s+(\w+)\s*:/g)].map(m => m[1]!);
  const unions  = [...source.matchAll(/\bunion\s+(\w+)\s*\{/g)].map(m => m[1]!);
  const structs = [...source.matchAll(/\bstruct\s+(\w+)\s*\{/g)].map(m => m[1]!);
  const rpcs    = [...source.matchAll(/rpc_service\s+(\w+)/g)].map(m => m[1]!);

  return { file: relPath, namespace, tables, enums, unions, structs, rpcs };
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

export function extractMarkdown(filePath: string, relPath: string): RawFileExtraction {
  const result: RawFileExtraction = {
    file: relPath,
    language: "markdown",
    symbols: [],
    conditions: [],
    dependencies: [],
    errors: [],
    validations: [],
    configAccesses: [],
    externalCalls: [],
    comments: [],
    extractionErrors: [],
  };

  let source: string;
  try { source = readFileSync(filePath, "utf8"); } catch { return result; }

  const lines = source.split("\n");
  let inCodeBlock = false;
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Section headers
    if (line.startsWith("#")) {
      currentSection = line.replace(/^#+\s*/, "").trim();
    }

    // Rule-like patterns in markdown: "IF ... → ..."
    const ruleM = line.match(/^\s*(?:IF|if)\s+(.+?)\s*(?:→|->|=>)\s*(.+)/);
    if (ruleM) {
      result.conditions.push({
        condition: ruleM[1]!.trim(),
        trueAction: ruleM[2]!.trim(),
        context: currentSection,
        evidence: { file: relPath, lineStart: lineNum, extractedBy: "markdown-extractor" },
      });
    }

    // Capture substantial prose as comments for semantic analysis
    if (line.trim().length > 30 && !line.startsWith("#") && !line.startsWith("|") && !line.startsWith("-")) {
      result.comments.push(line.trim());
    }
  }

  return result;
}

// ─── JSON Config files ────────────────────────────────────────────────────────

export function extractJsonConfig(filePath: string, relPath: string): RawFileExtraction {
  const result: RawFileExtraction = {
    file: relPath,
    language: "json",
    symbols: [],
    conditions: [],
    dependencies: [],
    errors: [],
    validations: [],
    configAccesses: [],
    externalCalls: [],
    comments: [],
    extractionErrors: [],
  };

  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filePath, "utf8")); } catch { return result; }

  // Flatten all key-value pairs as config items
  function flatten(obj: unknown, prefix: string): void {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k.startsWith("//")) continue; // skip comment keys
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        result.configAccesses.push({
          key,
          kind: "read",
          defaultValue: String(v),
          evidence: { file: relPath, extractedBy: "json-config-extractor" },
        });
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        flatten(v, key);
      }
    }
  }
  flatten(parsed, "");

  return result;
}
