/**
 * Pipeline Orchestrator
 *
 * Wires all stages together in order:
 *   scan → extract → interpret → resolve → model → report
 *
 * Supports:
 *   --full           Run all stages from scratch
 *   --incremental    Only re-extract files that changed since last run
 *   --stage <name>   Run a single stage
 *   --serve          Run the web explorer after analysis
 *
 * Each stage is independently runnable and writes its output to .architecture/raw/
 * so any stage can be re-run without repeating the others.
 */

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import pc from "picocolors";
import type { PipelineOptions, PipelineStage, StageResult, RawModel, ScannedFile } from "./types.ts";
import type { AssessConfig } from "./config.ts";
import { scan } from "./scan.ts";
import { interpret } from "./interpret.ts";
import { resolve } from "./resolve.ts";
import { writeModel } from "./model.ts";
import { generateReport } from "./report.ts";
import {
  extractTypeScript,
} from "../extractors/typescript.ts";
import {
  extractRust,
} from "../extractors/rust.ts";
import {
  extractCiWorkflow,
  extractCargoManifest,
  extractNpmManifest,
  extractBazelBuild,
  extractDockerfile,
  extractShellScript,
  extractFlatbuffers,
  extractMarkdown,
  extractJsonConfig,
} from "../extractors/ci-build.ts";

// ─── Stage timers ─────────────────────────────────────────────────────────────

function timer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}

// ─── Raw model cache ──────────────────────────────────────────────────────────

function loadCachedRawModel(config: AssessConfig): RawModel | null {
  const path = join(config.output.raw, "repository.json");
  if (!existsSync(path)) return null;
  try {
    // The repository.json is a summary; we need the full raw model from files.json + logic.json
    // Reconstruct enough of the raw model from cached fragments
    const filesPath = join(config.output.raw, "files.json");
    const ciPath    = join(config.output.raw, "ci.json");
    const buildsPath= join(config.output.raw, "builds.json");

    if (!existsSync(filesPath)) return null;

    const filesData  = JSON.parse(readFileSync(filesPath, "utf8")) as { files: ScannedFile[] };
    const ciData     = existsSync(ciPath)     ? JSON.parse(readFileSync(ciPath, "utf8"))     : { workflows: [] };
    const buildsData = existsSync(buildsPath) ? JSON.parse(readFileSync(buildsPath, "utf8")) : { bazelTargets: [], cargoManifests: [], npmManifests: [] };

    return {
      version:           "1",
      generatedAt:       new Date().toISOString(),
      repositoryRoot:    config.repoRoot,
      files:             filesData.files ?? [],
      extractions:       [],  // will be re-extracted
      ciWorkflows:       ciData.workflows ?? [],
      buildTargets:      buildsData.bazelTargets ?? [],
      cargoManifests:    buildsData.cargoManifests ?? [],
      npmManifests:      buildsData.npmManifests ?? [],
      flatbuffersSchemas:[],
      analysisGaps:      [],
    };
  } catch {
    return null;
  }
}

// ─── Extract stage ────────────────────────────────────────────────────────────

async function runExtract(
  files: ScannedFile[],
  config: AssessConfig,
  incremental: boolean,
  verbose: boolean,
): Promise<Omit<RawModel, "version" | "generatedAt" | "repositoryRoot">> {
  const extractors = config.extractors;
  const extractions:        RawModel["extractions"]        = [];
  const ciWorkflows:        RawModel["ciWorkflows"]        = [];
  const buildTargets:       RawModel["buildTargets"]       = [];
  const cargoManifests:     RawModel["cargoManifests"]     = [];
  const npmManifests:       RawModel["npmManifests"]       = [];
  const flatbuffersSchemas: RawModel["flatbuffersSchemas"] = [];
  const analysisGaps:       RawModel["analysisGaps"]       = [];

  const analyzable = files.filter(f => !f.ignored);
  let processed = 0;

  for (const file of analyzable) {
    // In incremental mode, skip unchanged files (except for manifest/config files which are always small)
    if (incremental && !file.changed) {
      const isConfig = file.language === "json" || file.language === "toml" || file.language === "yaml";
      if (!isConfig) continue;
    }

    processed++;
    if (verbose && processed % 50 === 0) {
      process.stdout.write(`\r  ${pc.dim(`[${processed}/${analyzable.length}]`)} Extracting...`);
    }

    try {
      switch (file.language) {
        case "typescript":
          if (extractors["typescript"]?.enabled) {
            extractions.push(extractTypeScript(file.absolutePath, file.path));
          }
          break;

        case "rust":
          if (extractors["rust"]?.enabled) {
            extractions.push(extractRust(file.absolutePath, file.path));
          }
          break;

        case "yaml":
          if (extractors["ci"]?.enabled && file.path.startsWith(".github/workflows/")) {
            ciWorkflows.push(extractCiWorkflow(file.absolutePath, file.path));
          }
          break;

        case "toml":
          if (extractors["toml"]?.enabled) {
            if (file.path.endsWith("Cargo.toml")) {
              const manifest = extractCargoManifest(file.absolutePath, file.path);
              if (manifest) cargoManifests.push(manifest);
            }
          }
          break;

        case "json":
          if (extractors["json"]?.enabled) {
            const name = file.path.split("/").pop() ?? "";
            // Only extract meaningful JSON config files — not huge lock files
            if (["package.json", "_identity.json", "build.json", "features.json", "dependencies.json"].includes(name)) {
              if (name === "package.json") {
                const manifest = extractNpmManifest(file.absolutePath, file.path);
                if (manifest) npmManifests.push(manifest);
              } else {
                extractions.push(extractJsonConfig(file.absolutePath, file.path));
              }
            }
          }
          break;

        case "bazel":
          if (extractors["bazel"]?.enabled) {
            const name = file.path.split("/").pop() ?? "";
            if (name === "BUILD.bazel" || name === "BUILD") {
              buildTargets.push(...extractBazelBuild(file.absolutePath, file.path));
            }
          }
          break;

        case "dockerfile":
          if (extractors["docker"]?.enabled) {
            extractions.push(extractDockerfile(file.absolutePath, file.path));
          }
          break;

        case "shell":
        case "powershell":
          if (extractors["shell"]?.enabled) {
            extractions.push(extractShellScript(file.absolutePath, file.path));
          }
          break;

        case "flatbuffers":
          if (extractors["flatbuffers"]?.enabled) {
            flatbuffersSchemas.push(extractFlatbuffers(file.absolutePath, file.path));
          }
          break;

        case "markdown":
          if (extractors["markdown"]?.enabled) {
            const name = file.path.split("/").pop() ?? "";
            // Only README files — not every .md
            if (name.toLowerCase().startsWith("readme") || name.toLowerCase() === "contributing.md") {
              extractions.push(extractMarkdown(file.absolutePath, file.path));
            }
          }
          break;

        case "unknown":
          analysisGaps.push({
            file: file.path,
            reason: "Unknown file type — no extractor available",
            impact: "low",
          });
          break;

        // Zig, Python, Go — no dedicated extractor yet
        case "zig":
        case "python":
        case "go":
          analysisGaps.push({
            file:     file.path,
            reason:   `Language "${file.language}" has no dedicated extractor. Behavior in this file is not represented in the semantic model.`,
            language: file.language,
            impact:   file.language === "python" ? "medium" : "low",
          });
          break;
      }
    } catch (e: any) {
      analysisGaps.push({
        file:   file.path,
        reason: `Extractor error: ${e.message}`,
        impact: "medium",
      });
    }
  }

  if (verbose) process.stdout.write("\n");

  return { files, extractions, ciWorkflows, buildTargets, cargoManifests, npmManifests, flatbuffersSchemas, analysisGaps };
}

// ─── Main run function ────────────────────────────────────────────────────────

export async function runPipeline(
  config: AssessConfig,
  options: PipelineOptions,
): Promise<{ success: boolean; stages: StageResult[] }> {
  const verbose   = options.verbose ?? false;
  const fullRun   = options.full ?? (!options.stage && !options.incremental);
  const incremental = options.incremental ?? false;
  const targetStage = options.stage;

  const results: StageResult[] = [];

  function log(msg: string): void {
    if (verbose) console.log(msg);
  }

  function header(name: string): void {
    console.log(`\n${pc.bold(pc.cyan(`▶ ${name}`))}`);
  }

  // Ensure output dirs
  for (const dir of Object.values(config.output)) {
    if (typeof dir === "string") {
      try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    }
  }

  // ── Stage: scan ────────────────────────────────────────────────────────────

  let rawModel: RawModel | null = null;

  if (!targetStage || targetStage === "scan" || fullRun) {
    header("Stage 1 — Repository Scan");
    const t = timer();

    const scanResult = await scan(config, verbose);
    log(pc.dim(`  Files: ${scanResult.stats.total} total, ${scanResult.stats.analyzed} analyzed, ${scanResult.stats.changed} changed`));

    results.push({
      stage:          "scan",
      success:        true,
      duration:       t(),
      itemsProcessed: scanResult.stats.total,
      warnings:       [],
      errors:         [],
    });

    if (targetStage === "scan") {
      console.log(pc.green(`✓ Scan complete — ${scanResult.stats.analyzed} files`));
      return { success: true, stages: results };
    }

    // ── Stage: extract ────────────────────────────────────────────────────────

    header("Stage 2 — Raw Extraction");
    const t2 = timer();

    const extractResult = await runExtract(scanResult.files, config, incremental, verbose);

    rawModel = {
      version:        "1",
      generatedAt:    new Date().toISOString(),
      repositoryRoot: config.repoRoot,
      ...extractResult,
    };

    const totalConditions = rawModel.extractions.reduce((n, e) => n + e.conditions.length, 0);
    const totalSymbols    = rawModel.extractions.reduce((n, e) => n + e.symbols.length, 0);
    const totalErrors     = rawModel.extractions.reduce((n, e) => n + e.errors.length, 0);
    log(pc.dim(`  ${rawModel.extractions.length} files extracted: ${totalSymbols} symbols, ${totalConditions} conditions, ${totalErrors} error patterns`));
    log(pc.dim(`  CI: ${rawModel.ciWorkflows.length} workflows | Build: ${rawModel.buildTargets.length} targets | Cargo: ${rawModel.cargoManifests.length} manifests`));

    results.push({
      stage:          "extract",
      success:        true,
      duration:       t2(),
      itemsProcessed: rawModel.extractions.length,
      warnings:       rawModel.analysisGaps.map(g => `${g.file}: ${g.reason}`).slice(0, 10),
      errors:         [],
    });

    if (targetStage === "extract") {
      console.log(pc.green(`✓ Extraction complete`));
      return { success: true, stages: results };
    }
  } else {
    // Load from cache for downstream stages
    rawModel = loadCachedRawModel(config);
    if (!rawModel) {
      console.error(pc.red("No cached raw model. Run --full first."));
      return { success: false, stages: results };
    }
  }

  // ── Stage: interpret ───────────────────────────────────────────────────────

  if (!targetStage || targetStage === "interpret" || fullRun) {
    header("Stage 3 — Semantic Interpretation");
    const t3 = timer();

    const interpreted = interpret(rawModel);

    log(pc.dim(`  ${interpreted.entities.length} entities | ${interpreted.rules.length} rules | ${interpreted.flows.length} flows`));
    log(pc.dim(`  ${interpreted.contradictions.length} contradictions | ${interpreted.potentialIssues.length} potential issues`));

    results.push({
      stage:          "interpret",
      success:        true,
      duration:       t3(),
      itemsProcessed: interpreted.entities.length + interpreted.rules.length + interpreted.flows.length,
      warnings:       interpreted.potentialIssues.map(i => i.description).slice(0, 5),
      errors:         [],
    });

    if (targetStage === "interpret") {
      console.log(pc.green(`✓ Interpretation complete`));
      return { success: true, stages: results };
    }

    // ── Stage: resolve ─────────────────────────────────────────────────────────

    if (!targetStage || targetStage === "resolve" || fullRun) {
      header("Stage 4 — Relationship Resolution");
      const t4 = timer();

      const relationships = resolve(interpreted, rawModel);
      log(pc.dim(`  ${relationships.length} relationships resolved`));

      results.push({
        stage:          "resolve",
        success:        true,
        duration:       t4(),
        itemsProcessed: relationships.length,
        warnings:       [],
        errors:         [],
      });

      // ── Stage: model ───────────────────────────────────────────────────────────

      if (!targetStage || targetStage === "model" || fullRun) {
        header("Stage 5 — Model Assembly");
        const t5 = timer();

        const finalModel = writeModel({
          raw:           rawModel,
          interpreted,
          relationships,
          config,
        });

        log(pc.dim(`  Wrote architecture.json: ${finalModel.entities.length} entities, ${finalModel.relationships.length} relationships`));

        results.push({
          stage:          "model",
          success:        true,
          duration:       t5(),
          itemsProcessed: finalModel.entities.length,
          warnings:       [],
          errors:         [],
        });

        // ── Stage: report ──────────────────────────────────────────────────────────

        if (!targetStage || targetStage === "report" || fullRun) {
          header("Stage 6 — Coverage Report");
          const t6 = timer();

          const report = generateReport(rawModel, finalModel, config);

          console.log(pc.green(`\n✓ Analysis complete`));
          console.log(pc.dim(`  Files analyzed:    ${report.summary.analyzedFiles} / ${report.summary.totalFiles}  (${report.summary.coveragePercent}%)`));
          console.log(pc.dim(`  Entities:          ${finalModel.entities.length}`));
          console.log(pc.dim(`  Relationships:     ${finalModel.relationships.length}`));
          console.log(pc.dim(`  Rules & checks:    ${finalModel.rules.length}`));
          console.log(pc.dim(`  Flows:             ${finalModel.flows.length}`));
          console.log(pc.dim(`  Review queue:      ${report.reviewQueue.total}`));
          console.log(pc.dim(`  Contradictions:    ${report.reviewQueue.contradictions}`));
          console.log(pc.dim(`  Potential issues:  ${report.reviewQueue.potentialIssues}`));
          console.log("");
          console.log(pc.cyan(`  Output:`));
          console.log(pc.dim(`    ${config.output.semantic}/architecture.json`));
          console.log(pc.dim(`    ${config.output.reports}/coverage.json`));
          console.log(pc.dim(`    ${config.output.reports}/coverage.txt`));
          console.log("");
          console.log(pc.cyan(`  Start the explorer:`));
          console.log(pc.bold(`    bun run explorer`));

          results.push({
            stage:          "report",
            success:        true,
            duration:       t6(),
            itemsProcessed: 1,
            warnings:       [],
            errors:         [],
          });
        }
      }
    }
  }

  // ── Stage: serve ───────────────────────────────────────────────────────────

  if (options.serve || targetStage === "serve") {
    await serveExplorer(config);
  }

  return { success: true, stages: results };
}

// ─── Static file server for the explorer ─────────────────────────────────────

async function serveExplorer(config: AssessConfig): Promise<void> {
  const explorerDist = join(
    config.repoRoot,
    ".tools/automation/assessment/web/dist",
  );
  const modelPath    = config.web.modelPath;
  const overridesPath= config.web.overridesPath;
  const port         = config.web.port;

  // Check if the explorer has been built
  if (!existsSync(explorerDist)) {
    console.log(pc.yellow("\n  Explorer not built yet."));
    console.log(pc.dim(`  Build it with: cd .tools/automation/assessment/web && bun run build`));
    console.log(pc.dim(`  Then run:      bun run explorer`));
    return;
  }

  console.log(pc.bold(pc.cyan(`\n▶ Starting Explorer on http://localhost:${port}`)));

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // API: serve the architecture model
      if (path === "/api/model") {
        try {
          const data = readFileSync(modelPath, "utf8");
          return new Response(data, { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        } catch {
          return new Response(JSON.stringify({ error: "Model not found. Run bun run assess first." }), { status: 404, headers: { "Content-Type": "application/json" } });
        }
      }

      // API: serve human overrides
      if (path === "/api/overrides") {
        if (req.method === "GET") {
          try {
            const data = existsSync(overridesPath) ? readFileSync(overridesPath, "utf8") : "{}";
            return new Response(data, { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
          } catch {
            return new Response("{}", { headers: { "Content-Type": "application/json" } });
          }
        }
        if (req.method === "POST") {
          try {
            const body = await req.text();
            const { writeFileSync, mkdirSync } = await import("fs");
            const { dirname } = await import("path");
            mkdirSync(dirname(overridesPath), { recursive: true });
            writeFileSync(overridesPath, body, "utf8");
            return new Response('{"ok":true}', { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
          } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
          }
        }
        if (req.method === "OPTIONS") {
          return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
        }
      }

      // API: coverage report
      if (path === "/api/coverage") {
        try {
          const coveragePath = join(config.output.reports, "coverage.json");
          const data = readFileSync(coveragePath, "utf8");
          return new Response(data, { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        } catch {
          return new Response("{}", { headers: { "Content-Type": "application/json" } });
        }
      }

      // Serve static files from dist/
      let filePath = path === "/" ? "/index.html" : path;
      const fullPath = join(explorerDist, filePath);

      try {
        const file = Bun.file(fullPath);
        const exists = await file.exists();
        if (exists) {
          return new Response(file, {
            headers: { "Content-Type": getMimeType(filePath) },
          });
        }
      } catch { /* fallthrough */ }

      // SPA fallback — serve index.html for all routes
      try {
        const indexFile = Bun.file(join(explorerDist, "index.html"));
        return new Response(indexFile, { headers: { "Content-Type": "text/html" } });
      } catch {
        return new Response("404 Not Found", { status: 404 });
      }
    },
  });

  console.log(pc.green(`  Explorer running at http://localhost:${port}`));
  console.log(pc.dim(`  Press Ctrl+C to stop.`));

  // Keep alive
  await new Promise(() => {});
}

function getMimeType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}
