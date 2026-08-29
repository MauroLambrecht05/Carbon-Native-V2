/**
 * Configuration loader for the assessment pipeline.
 * Reads assess.config.json and resolves all paths relative to the repo root.
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";

export interface AssessConfig {
  repoRoot: string;
  output: {
    dir: string;
    raw: string;
    semantic: string;
    human: string;
    prompts: string;
    reports: string;
  };
  analysis: {
    depth: "full" | "shallow";
    maxFileSizeBytes: number;
    includeTestFiles: boolean;
    includeLabFiles: boolean;
  };
  ignore: {
    directories: string[];
    files: string[];
    patterns: string[];
  };
  extractors: Record<string, { enabled: boolean; [key: string]: unknown }>;
  semantic: {
    confidence: Record<string, string>;
    entityTypes: string[];
    relationshipTypes: string[];
  };
  incremental: {
    enabled: boolean;
    hashAlgorithm: string;
    manifestFile: string;
  };
  web: {
    port: number;
    title: string;
    modelPath: string;
    overridesPath: string;
  };
  schemaVersion: string;
}

export function loadConfig(configPath?: string, repoRoot?: string): AssessConfig {
  // Determine repo root: walk up from this file's directory
  // stages/config.ts → assessment/ → automation/ → tools/ → V2/
  const selfDir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
  const assessmentDir = resolve(selfDir, ".."); // stages -> assessment
  const inferredRoot = repoRoot ?? resolve(assessmentDir, "../../.."); // assessment -> automation -> tools -> V2

  const configFile = configPath ?? join(assessmentDir, "assess.config.json");

  if (!existsSync(configFile)) {
    throw new Error(`Config file not found: ${configFile}`);
  }

  const raw = JSON.parse(readFileSync(configFile, "utf8")) as Partial<AssessConfig>;

  // Resolve output paths
  const outputDir = join(inferredRoot, (raw.output?.dir ?? ".architecture"));

  return {
    repoRoot: inferredRoot,
    output: {
      dir:      outputDir,
      raw:      join(inferredRoot, raw.output?.raw      ?? ".architecture/raw"),
      semantic: join(inferredRoot, raw.output?.semantic ?? ".architecture/semantic"),
      human:    join(inferredRoot, raw.output?.human    ?? ".architecture/human"),
      prompts:  join(inferredRoot, raw.output?.prompts  ?? ".architecture/prompts"),
      reports:  join(inferredRoot, raw.output?.reports  ?? ".architecture/reports"),
    },
    analysis: {
      depth:              (raw.analysis?.depth ?? "full") as "full" | "shallow",
      maxFileSizeBytes:   raw.analysis?.maxFileSizeBytes ?? 524288,
      includeTestFiles:   raw.analysis?.includeTestFiles ?? true,
      includeLabFiles:    raw.analysis?.includeLabFiles  ?? false,
    },
    ignore: {
      directories: raw.ignore?.directories ?? [],
      files:       raw.ignore?.files       ?? [],
      patterns:    raw.ignore?.patterns    ?? [],
    },
    extractors: raw.extractors ?? {},
    semantic: {
      confidence:        raw.semantic?.confidence        ?? {},
      entityTypes:       raw.semantic?.entityTypes       ?? [],
      relationshipTypes: raw.semantic?.relationshipTypes ?? [],
    },
    incremental: {
      enabled:       raw.incremental?.enabled       ?? true,
      hashAlgorithm: raw.incremental?.hashAlgorithm ?? "sha256",
      manifestFile: (() => {
      const raw_mf = raw.incremental?.manifestFile ?? ".architecture/raw/manifest.json";
      // Don't re-join if it's already absolute
      return raw_mf.startsWith("/") || /^[A-Z]:/i.test(raw_mf)
        ? raw_mf
        : join(inferredRoot, raw_mf);
    })(),
    },
    web: {
      port:          raw.web?.port          ?? 4040,
      title:         raw.web?.title         ?? "Carbon Native — Semantic Explorer",
      modelPath:     join(inferredRoot, raw.web?.modelPath     ?? ".architecture/semantic/architecture.json"),
      overridesPath: join(inferredRoot, raw.web?.overridesPath ?? ".architecture/human/overrides.json"),
    },
    schemaVersion: raw.schemaVersion ?? "1.0.0",
  };
}

export function ensureOutputDirs(config: AssessConfig): void {
  for (const dir of Object.values(config.output)) {
    try {
      Bun.spawnSync(["mkdir", "-p", dir]);
    } catch { /* ignore */ }
    // Use Bun's mkdirSync equivalent
    import("fs").then(fs => {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    });
  }
}
