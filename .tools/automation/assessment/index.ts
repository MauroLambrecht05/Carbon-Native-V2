#!/usr/bin/env bun
/**
 * Carbon Native — Semantic Assessment Pipeline
 *
 * Entry point. Parses CLI args and delegates to the pipeline orchestrator.
 *
 * Usage:
 *   bun run index.ts                     # full analysis
 *   bun run index.ts --full              # same
 *   bun run index.ts --incremental       # only re-extract changed files
 *   bun run index.ts --stage scan        # single stage
 *   bun run index.ts --stage extract
 *   bun run index.ts --stage interpret
 *   bun run index.ts --stage resolve
 *   bun run index.ts --stage model
 *   bun run index.ts --stage report
 *   bun run index.ts --serve             # start the explorer (after analysis)
 *   bun run index.ts --full --serve      # analyse then immediately serve
 *   bun run index.ts --help
 */

import pc from "picocolors";
import { loadConfig } from "./stages/config.ts";
import { runPipeline } from "./stages/pipeline.ts";
import type { PipelineOptions, PipelineStage } from "./stages/types.ts";

// ─── Help ─────────────────────────────────────────────────────────────────────

const HELP = `
${pc.bold("Carbon Native — Semantic Assessment Pipeline")}

${pc.dim("Analyzes the entire repository and produces a semantic model of how the system works,")}
${pc.dim("together with an interactive web explorer.")}

${pc.bold("Usage:")}
  bun run index.ts [options]

${pc.bold("Options:")}
  --full                  Run the complete pipeline from scratch  ${pc.dim("(default)")}
  --incremental           Re-extract only files that changed since last run
  --stage <name>          Run a single stage:
                            scan · extract · interpret · resolve · model · report · serve
  --serve                 Start the interactive web explorer
  --config <path>         Path to assess.config.json  ${pc.dim("(default: ./assess.config.json)")}
  --verbose               Print detailed progress
  --help                  Show this help

${pc.bold("Examples:")}
  bun run index.ts                        # full analysis
  bun run index.ts --serve                # analysis + open explorer
  bun run index.ts --incremental          # fast re-run after code changes
  bun run index.ts --stage scan           # only scan files

${pc.bold("Output:")}
  .architecture/semantic/architecture.json   The semantic model
  .architecture/reports/coverage.json        Coverage report
  .architecture/reports/coverage.txt         Human-readable summary
  .architecture/raw/                          Raw extraction fragments
  .architecture/human/overrides.json         Human review edits

${pc.bold("Explorer:")}
  After analysis, start the explorer:
    bun run explorer
  Then open: ${pc.cyan("http://localhost:4040")}
`;

// ─── Args parser ──────────────────────────────────────────────────────────────

function parseArgs(args: string[]): PipelineOptions & { help: boolean; config?: string; verbose: boolean } {
  const opts = {
    full:        false,
    incremental: false,
    serve:       false,
    stage:       undefined as PipelineStage | undefined,
    config:      undefined as string | undefined,
    verbose:     false,
    help:        false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--full":        opts.full        = true;  break;
      case "--incremental": opts.incremental = true;  break;
      case "--serve":       opts.serve       = true;  break;
      case "--verbose":     opts.verbose     = true;  break;
      case "--help":        opts.help        = true;  break;
      case "--config":
        opts.config = args[++i];
        break;
      case "--stage": {
        const next = args[++i];
        const valid: PipelineStage[] = ["scan", "extract", "interpret", "resolve", "model", "report", "serve"];
        if (next && valid.includes(next as PipelineStage)) {
          opts.stage = next as PipelineStage;
        } else {
          console.error(pc.red(`Unknown stage: "${next}". Valid: ${valid.join(", ")}`));
          process.exit(1);
        }
        break;
      }
    }
  }

  // Default: full run
  if (!opts.full && !opts.incremental && !opts.stage && !opts.serve && !opts.help) {
    opts.full = true;
  }

  return opts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log(pc.bold(pc.cyan("\n  Carbon Native — Semantic Assessment Pipeline\n")));

  let config;
  try {
    config = loadConfig(opts.config);
  } catch (e: any) {
    console.error(pc.red(`  Config error: ${e.message}`));
    process.exit(1);
  }

  if (opts.verbose) {
    console.log(pc.dim(`  Repository root: ${config.repoRoot}`));
    console.log(pc.dim(`  Output: ${config.output.dir}`));
    console.log("");
  }

  const start = Date.now();

  const { success, stages } = await runPipeline(config, {
    full:        opts.full,
    incremental: opts.incremental,
    stage:       opts.stage,
    serve:       opts.serve,
    verbose:     opts.verbose,
  });

  if (!success) {
    console.error(pc.red("\n  Pipeline failed. Check the output above for details."));
    process.exit(1);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);

  if (opts.verbose && stages.length > 0) {
    console.log(pc.dim("\n  Stage timings:"));
    for (const s of stages) {
      const icon = s.success ? pc.green("✓") : pc.red("✗");
      console.log(pc.dim(`    ${icon} ${s.stage.padEnd(12)} ${s.duration}ms  (${s.itemsProcessed} items)`));
    }
  }

  if (!opts.serve) {
    console.log(pc.dim(`\n  Total: ${duration}s`));
  }
}

main().catch(e => {
  console.error(pc.red(`\n  Fatal: ${e.message}`));
  if (process.env["VERBOSE"]) console.error(e);
  process.exit(1);
});
