/**
 * Stage 6 — Coverage Reporter
 *
 * Generates .architecture/reports/coverage.json with:
 *   - File coverage statistics
 *   - Entity counts by type
 *   - Confidence distribution
 *   - Analysis gaps and reasons
 *   - Review queue summary
 *   - Per-language breakdown
 *
 * Also writes a human-readable coverage.txt summary.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  RawModel,
  ArchitectureModel,
  CoverageReport,
  Language,
  EntityType,
} from "./types.ts";
import type { AssessConfig } from "./config.ts";

// ─── Main reporter ────────────────────────────────────────────────────────────

export function generateReport(
  raw: RawModel,
  model: ArchitectureModel,
  config: AssessConfig,
): CoverageReport {
  try { mkdirSync(config.output.reports, { recursive: true }); } catch { /* exists */ }

  // ── File statistics ────────────────────────────────────────────────────────

  const totalFiles    = raw.files.length;
  const ignoredFiles  = raw.files.filter(f => f.ignored).length;
  const analyzedFiles = totalFiles - ignoredFiles;
  const skippedFiles  = raw.analysisGaps.length;
  const coveragePct   = totalFiles > 0 ? Math.round((analyzedFiles / totalFiles) * 100) : 0;

  // ── Language breakdown ────────────────────────────────────────────────────

  const byLanguage: CoverageReport["byLanguage"] = {} as CoverageReport["byLanguage"];
  for (const file of raw.files) {
    const lang = file.language;
    if (!byLanguage[lang]) byLanguage[lang] = { files: 0, analyzed: 0 };
    byLanguage[lang].files++;
    if (!file.ignored) byLanguage[lang].analyzed++;
  }

  // ── Entity counts ─────────────────────────────────────────────────────────

  const entityCounts = {
    products:       countByType(model.entities, "PRODUCT"),
    solutions:      countByType(model.entities, "SOLUTION"),
    capabilities:   countByType(model.entities, "CAPABILITY"),
    contracts:      countByType(model.entities, "CONTRACT"),
    integrations:   countByType(model.entities, "INTEGRATION") + countByType(model.entities, "EXTERNAL_SYSTEM"),
    infrastructure: countByType(model.entities, "INFRASTRUCTURE"),
    flows:          model.flows.length,
    rules:          model.rules.length,
    checks:         model.rules.filter(r => r.kind === "check").length,
    decisions:      model.rules.filter(r => r.kind === "rule" || r.kind === "policy").length,
    errors:         countByType(model.entities, "ERROR"),
    configurations: countByType(model.entities, "CONFIGURATION") + countByType(model.entities, "FEATURE_FLAG"),
    technologies:   countByType(model.entities, "TECHNOLOGY"),
  };

  // ── Confidence distribution ───────────────────────────────────────────────

  const allItems = [
    ...model.entities,
    ...model.rules,
    ...model.flows,
  ];

  const confidence = {
    confirmed: allItems.filter(i => i.confidence === "confirmed").length,
    inferred:  allItems.filter(i => i.confidence === "inferred").length,
    uncertain: allItems.filter(i => i.confidence === "uncertain").length,
    unknown:   allItems.filter(i => i.confidence === "unknown").length,
  };

  // ── Review queue ──────────────────────────────────────────────────────────

  const reviewQueue = {
    unknowns:         allItems.filter(i => i.confidence === "unknown").length,
    inferences:       allItems.filter(i => i.confidence === "inferred").length,
    contradictions:   model.contradictions.length,
    potentialIssues:  model.potentialIssues.length,
    total: 0,
  };
  reviewQueue.total =
    reviewQueue.unknowns + reviewQueue.inferences +
    reviewQueue.contradictions + reviewQueue.potentialIssues;

  // ── Skipped files ─────────────────────────────────────────────────────────

  const skipped = raw.analysisGaps.map(g => ({ file: g.file, reason: g.reason }));

  // ── Assemble report ───────────────────────────────────────────────────────

  const report: CoverageReport = {
    version: "1",
    generatedAt: model.meta.generatedAt,
    summary: {
      totalFiles,
      analyzedFiles,
      skippedFiles,
      ignoredFiles,
      coveragePercent: coveragePct,
    },
    byLanguage,
    entities: entityCounts,
    confidence,
    analysisGaps: raw.analysisGaps,
    reviewQueue,
    skippedFiles: skipped,
  };

  // ── Write JSON ────────────────────────────────────────────────────────────

  writeFileSync(
    join(config.output.reports, "coverage.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  // ── Write human-readable summary ──────────────────────────────────────────

  const txt = formatTextReport(report, model);
  writeFileSync(join(config.output.reports, "coverage.txt"), txt, "utf8");

  return report;
}

// ─── Text formatter ───────────────────────────────────────────────────────────

function formatTextReport(report: CoverageReport, model: ArchitectureModel): string {
  const lines: string[] = [];
  const hr = "─".repeat(60);

  lines.push("Carbon Native V2 — Semantic Analysis Coverage Report");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(hr);
  lines.push("");

  lines.push("FILE COVERAGE");
  lines.push(`  Total files:    ${report.summary.totalFiles}`);
  lines.push(`  Analyzed:       ${report.summary.analyzedFiles}  (${report.summary.coveragePercent}%)`);
  lines.push(`  Ignored:        ${report.summary.ignoredFiles}`);
  lines.push(`  Skipped:        ${report.summary.skippedFiles}`);
  lines.push("");

  lines.push("BY LANGUAGE");
  for (const [lang, { files, analyzed }] of sortedEntries(report.byLanguage)) {
    if (files === 0) continue;
    const pct = Math.round((analyzed / files) * 100);
    lines.push(`  ${lang.padEnd(16)} ${String(files).padStart(5)} files   ${String(analyzed).padStart(5)} analyzed  (${pct}%)`);
  }
  lines.push("");

  lines.push("SEMANTIC ENTITIES");
  lines.push(`  Products:        ${report.entities.products}`);
  lines.push(`  Solutions:       ${report.entities.solutions}`);
  lines.push(`  Capabilities:    ${report.entities.capabilities}`);
  lines.push(`  Contracts:       ${report.entities.contracts}`);
  lines.push(`  Integrations:    ${report.entities.integrations}`);
  lines.push(`  Infrastructure:  ${report.entities.infrastructure}`);
  lines.push(`  Technologies:    ${report.entities.technologies}`);
  lines.push(`  Configuration:   ${report.entities.configurations}`);
  lines.push(`  Flows:           ${report.entities.flows}`);
  lines.push(`  Rules:           ${report.entities.rules}`);
  lines.push(`  Checks:          ${report.entities.checks}`);
  lines.push(`  Decisions:       ${report.entities.decisions}`);
  lines.push(`  Total entities:  ${model.entities.length}`);
  lines.push(`  Relationships:   ${model.relationships.length}`);
  lines.push("");

  lines.push("CONFIDENCE DISTRIBUTION");
  lines.push(`  Confirmed:  ${report.confidence.confirmed}`);
  lines.push(`  Inferred:   ${report.confidence.inferred}`);
  lines.push(`  Uncertain:  ${report.confidence.uncertain}`);
  lines.push(`  Unknown:    ${report.confidence.unknown}`);
  lines.push("");

  lines.push("REVIEW QUEUE");
  lines.push(`  Unknowns:           ${report.reviewQueue.unknowns}`);
  lines.push(`  Inferences to check:${report.reviewQueue.inferences}`);
  lines.push(`  Contradictions:     ${report.reviewQueue.contradictions}`);
  lines.push(`  Potential issues:   ${report.reviewQueue.potentialIssues}`);
  lines.push(`  Total in queue:     ${report.reviewQueue.total}`);
  lines.push("");

  if (report.analysisGaps.length > 0) {
    lines.push("ANALYSIS GAPS");
    for (const gap of report.analysisGaps.slice(0, 20)) {
      lines.push(`  [${gap.impact.toUpperCase().padEnd(6)}] ${gap.file}`);
      lines.push(`          ${gap.reason}`);
    }
    if (report.analysisGaps.length > 20) {
      lines.push(`  ... and ${report.analysisGaps.length - 20} more. See coverage.json for full list.`);
    }
    lines.push("");
  }

  if (model.contradictions.length > 0) {
    lines.push("CONTRADICTIONS");
    for (const c of model.contradictions) {
      lines.push(`  ${c.description}`);
      lines.push(`    A: ${c.sourceA.location} — ${c.sourceA.claim.slice(0, 80)}`);
      lines.push(`    B: ${c.sourceB.location} — ${c.sourceB.claim.slice(0, 80)}`);
      if (c.resolution) lines.push(`    Resolution: ${c.resolution}`);
    }
    lines.push("");
  }

  if (model.potentialIssues.length > 0) {
    lines.push("POTENTIAL ISSUES");
    for (const issue of model.potentialIssues) {
      lines.push(`  [${issue.severity.toUpperCase().padEnd(6)}] ${issue.kind}`);
      lines.push(`          ${issue.description.slice(0, 100)}`);
    }
    lines.push("");
  }

  lines.push(hr);
  lines.push("Use the interactive explorer to navigate the full model:");
  lines.push("  bun run explorer (from .tools/automation/assessment/)");

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countByType(entities: ArchitectureModel["entities"], type: EntityType): number {
  return entities.filter(e => e.type === type).length;
}

function sortedEntries<V>(obj: Record<string, V>): Array<[string, V]> {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}
