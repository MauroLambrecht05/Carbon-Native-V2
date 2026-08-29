/**
 * Stage 1 — Repository Scanner
 *
 * Walks the entire repository, classifies every file by language and tier,
 * computes a SHA-256 hash for incremental analysis, and loads the previous
 * manifest to mark changed/unchanged files.
 *
 * Output: .architecture/raw/files.json  (ScannedFile[])
 *         .architecture/raw/manifest.json  (hash manifest for incremental runs)
 */

import { createHash } from "crypto";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join, relative, extname, basename, sep, dirname } from "path";
import type { ScannedFile, Language, RepotTier, AnalysisGap } from "./types.ts";
import type { AssessConfig } from "./config.ts";
import pc from "picocolors";

// ─── Language Detection ───────────────────────────────────────────────────────

const EXTENSION_MAP: Record<string, Language> = {
  ".ts":   "typescript",
  ".tsx":  "typescript",
  ".mts":  "typescript",
  ".cts":  "typescript",
  ".rs":   "rust",
  ".zig":  "zig",
  ".cpp":  "cpp",
  ".cc":   "cpp",
  ".cxx":  "cpp",
  ".c":    "cpp",
  ".h":    "cpp",
  ".hpp":  "cpp",
  ".go":   "go",
  ".py":   "python",
  ".yaml": "yaml",
  ".yml":  "yaml",
  ".toml": "toml",
  ".json": "json",
  ".md":   "markdown",
  ".sh":   "shell",
  ".bash": "shell",
  ".ps1":  "powershell",
  ".fbs":  "flatbuffers",
  ".bzl":  "starlark",
};

const FILENAME_MAP: Record<string, Language> = {
  "BUILD.bazel": "bazel",
  "MODULE.bazel": "bazel",
  "WORKSPACE": "bazel",
  "WORKSPACE.bazel": "bazel",
  ".bazelrc": "bazel",
  "Dockerfile": "dockerfile",
};

function detectLanguage(filePath: string): Language {
  const name = basename(filePath);
  if (FILENAME_MAP[name]) return FILENAME_MAP[name]!;

  // Dockerfile variants
  if (name.startsWith("Dockerfile")) return "dockerfile";

  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? "unknown";
}

// ─── Tier Detection ───────────────────────────────────────────────────────────

function detectTier(relPath: string): { tier: RepotTier; product?: string; solution?: string } {
  const parts = relPath.split(sep);
  const first = parts[0] ?? "";
  const second = parts[1] ?? "";

  if (first === "products") {
    return { tier: "product", product: second };
  }
  if (first === "solutions") {
    if (second === "contracts")      return { tier: "contracts",      solution: parts[2] };
    if (second === "capabilities")   return { tier: "capabilities",   solution: parts[2] };
    if (second === "infrastructure") return { tier: "infrastructure", solution: parts[2] };
    if (second === "integrations")   return { tier: "integrations",   solution: parts[2] };
    if (second === "interface")      return { tier: "interface",      solution: parts[2] };
    return { tier: "capabilities", solution: second };
  }
  if (first === ".tools") return { tier: "tooling" };
  if (first === ".config") return { tier: "config" };
  if (first === ".github") return { tier: "ci" };
  if (first === "labs")    return { tier: "labs" };
  return { tier: "config" };
}

// ─── Ignore Logic ─────────────────────────────────────────────────────────────

function shouldIgnoreDirectory(dirPath: string, ignoreDirs: string[], repoRoot: string): boolean {
  const rel = relative(repoRoot, dirPath).split(sep).join("/");
  for (const ignored of ignoreDirs) {
    // exact match or prefix match
    if (rel === ignored || rel.startsWith(ignored + "/")) return true;
    // basename match (e.g. "node_modules" matches any node_modules anywhere)
    const parts = rel.split("/");
    if (parts.some(p => p === ignored)) return true;
  }
  return false;
}

function shouldIgnoreFile(
  filePath: string,
  ignoreFiles: string[],
  ignorePatterns: string[],
  repoRoot: string,
): { ignored: boolean; reason?: string } {
  const name = basename(filePath);
  const rel = relative(repoRoot, filePath).split(sep).join("/");

  for (const pat of ignoreFiles) {
    if (matchGlob(name, pat)) return { ignored: true, reason: `matches ignore pattern "${pat}"` };
    if (matchGlob(rel, pat))  return { ignored: true, reason: `matches ignore pattern "${pat}"` };
  }
  for (const pat of ignorePatterns) {
    if (matchGlob(rel, pat)) return { ignored: true, reason: `matches ignore pattern "${pat}"` };
  }
  return { ignored: false };
}

/** Minimal glob matching — supports *, **, ? */
function matchGlob(str: string, pattern: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*")
    .replace(/\?/g, "[^/]");
  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch {
    return false;
  }
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

function hashFile(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return "error";
  }
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

type Manifest = Record<string, string>; // relPath → hash

function loadManifest(manifestPath: string): Manifest {
  try {
    if (existsSync(manifestPath)) {
      return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    }
  } catch { /* first run */ }
  return {};
}

function saveManifest(manifestPath: string, manifest: Manifest): void {
  try { mkdirSync(dirname(manifestPath), { recursive: true }); } catch { /* exists */ }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

// ─── Walker ───────────────────────────────────────────────────────────────────

interface ScanResult {
  files: ScannedFile[];
  gaps: AnalysisGap[];
  stats: {
    total: number;
    analyzed: number;
    ignored: number;
    skipped: number;
    changed: number;
  };
}

export async function scan(config: AssessConfig, verbose = false): Promise<ScanResult> {
  const repoRoot = config.repoRoot;
  const ignoreDirs = config.ignore.directories;
  const ignoreFiles = config.ignore.files;
  const ignorePatterns = config.ignore.patterns;
  const manifestPath = config.incremental.manifestFile; // already absolute from loadConfig
  const maxSize = config.analysis.maxFileSizeBytes;

  const previousManifest = loadManifest(manifestPath);
  const newManifest: Manifest = {};

  const files: ScannedFile[] = [];
  const gaps: AnalysisGap[] = [];
  let total = 0, analyzed = 0, ignored = 0, skipped = 0, changed = 0;

  if (verbose) console.log(pc.cyan(`  Scanning ${repoRoot}...`));

  // Walk directory recursively using Node's readdirSync (handles hidden dirs)
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof statSync> | null = null;
      try { stat = statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        if (!shouldIgnoreDirectory(fullPath, ignoreDirs, repoRoot)) {
          await walk(fullPath);
        }
        continue;
      }

      if (!stat.isFile()) continue;
      total++;

      const relPath = relative(repoRoot, fullPath).split(sep).join("/");
      const language = detectLanguage(fullPath);
      const { tier, product, solution } = detectTier(relPath);

      // Check ignore rules
      const ignoreResult = shouldIgnoreFile(fullPath, ignoreFiles, ignorePatterns, repoRoot);
      if (ignoreResult.ignored) {
        ignored++;
        files.push({
          path: relPath,
          absolutePath: fullPath,
          language,
          size: stat.size,
          hash: "",
          changed: false,
          tier,
          product,
          solution,
          ignored: true,
          ignoreReason: ignoreResult.reason,
        });
        continue;
      }

      // Size check
      if (stat.size > maxSize) {
        skipped++;
        gaps.push({
          file: relPath,
          reason: `File too large (${(stat.size / 1024).toFixed(0)} KB > ${(maxSize / 1024).toFixed(0)} KB limit)`,
          language: language as string,
          impact: "medium",
        });
        files.push({
          path: relPath,
          absolutePath: fullPath,
          language,
          size: stat.size,
          hash: "",
          changed: false,
          tier,
          product,
          solution,
          ignored: true,
          ignoreReason: "file too large",
        });
        continue;
      }

      // Unknown language without extractors
      if (language === "unknown") {
        const ext = extname(fullPath);
        if (ext && ext !== "") {
          gaps.push({
            file: relPath,
            reason: `No analyzer for extension "${ext}"`,
            language: ext,
            impact: "low",
          });
        }
      }

      const hash = hashFile(fullPath);
      const fileChanged = previousManifest[relPath] !== hash;
      if (fileChanged) changed++;

      newManifest[relPath] = hash;
      analyzed++;

      files.push({
        path: relPath,
        absolutePath: fullPath,
        language,
        size: stat.size,
        hash,
        changed: fileChanged,
        tier,
        product,
        solution,
        ignored: false,
      });
    }
  }

  await walk(repoRoot);

  // Save updated manifest
  saveManifest(manifestPath, newManifest);

  if (verbose) {
    console.log(pc.green(`  Scanned ${total} files: ${analyzed} analyzed, ${ignored} ignored, ${skipped} skipped, ${changed} changed`));
  }

  return {
    files,
    gaps,
    stats: { total, analyzed, ignored, skipped, changed },
  };
}
