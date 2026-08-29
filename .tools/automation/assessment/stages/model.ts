/**
 * Stage 5 — Model Writer
 *
 * Merges everything into the final ArchitectureModel, applies human overrides,
 * builds indexes, and writes .architecture/semantic/architecture.json.
 *
 * Also writes .architecture/raw/repository.json and .architecture/raw/files.json
 * so every stage's output is independently inspectable.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  RawModel,
  ArchitectureModel,
  SemanticEntity,
  SemanticRelationship,
  SemanticRule,
  SemanticFlow,
  Contradiction,
  PotentialIssue,
  HumanModel,
  HumanOverride,
  EntityType,
} from "./types.ts";
import type { InterpretResult } from "./interpret.ts";
import type { AssessConfig } from "./config.ts";

// ─── Main writer ──────────────────────────────────────────────────────────────

export interface ModelWriterInput {
  raw:            RawModel;
  interpreted:    InterpretResult;
  relationships:  SemanticRelationship[];
  config:         AssessConfig;
}

export function writeModel(input: ModelWriterInput): ArchitectureModel {
  const { raw, interpreted, relationships, config } = input;

  // 1. Load human overrides (if any)
  const humanModel = loadHumanModel(config.output.human);

  // 2. Merge human overrides into semantic entities
  const entities      = applyEntityOverrides(interpreted.entities, humanModel);
  const rules         = applyRuleOverrides(interpreted.rules, humanModel);
  const flows         = applyFlowOverrides(interpreted.flows, humanModel);
  const rels          = applyRelationshipOverrides(relationships, humanModel);

  // 3. Add human additions
  const allEntities      = [...entities,   ...(humanModel.additions.entities      ?? [])];
  const allRules         = [...rules,      ...(humanModel.additions.rules         ?? [])];
  const allFlows         = [...flows,      ...(humanModel.additions.flows         ?? [])];
  const allRelationships = [...rels,       ...(humanModel.additions.relationships  ?? [])];

  // 4. Assemble final model
  const model: ArchitectureModel = {
    meta: {
      version:       "1.0.0",
      schemaVersion: "1",
      generatedAt:   new Date().toISOString(),
      repositoryRoot: config.repoRoot,
      analysisDepth:  config.analysis.depth,
      toolVersion:    "1.0.0",
    },
    entities:       allEntities,
    relationships:  allRelationships,
    rules:          allRules,
    flows:          allFlows,
    contradictions: interpreted.contradictions,
    potentialIssues: interpreted.potentialIssues,
  };

  // 5. Ensure output directories exist
  for (const dir of [config.output.raw, config.output.semantic, config.output.human, config.output.reports]) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  }

  // 6. Write raw model fragments
  writeJson(join(config.output.raw, "files.json"), {
    version: "1",
    generatedAt: model.meta.generatedAt,
    files: raw.files,
  });

  writeJson(join(config.output.raw, "repository.json"), {
    version: "1",
    generatedAt: model.meta.generatedAt,
    stats: {
      totalFiles:    raw.files.length,
      analyzedFiles: raw.files.filter(f => !f.ignored).length,
      ignoredFiles:  raw.files.filter(f => f.ignored).length,
      languages:     countByLanguage(raw.files),
      tiers:         countByTier(raw.files),
    },
    cargoManifests:     raw.cargoManifests.map(m => ({ file: m.file, name: m.packageName, version: m.version, bins: m.bins })),
    npmManifests:       raw.npmManifests.map(m => ({ file: m.file, name: m.name, scripts: m.scripts })),
    ciWorkflows:        raw.ciWorkflows.map(w => ({ file: w.file, name: w.name, triggers: w.triggers, jobCount: w.jobs.length })),
    buildTargets:       raw.buildTargets.slice(0, 200),
    flatbuffersSchemas: raw.flatbuffersSchemas,
    analysisGaps:       raw.analysisGaps,
  });

  writeJson(join(config.output.raw, "logic.json"), {
    version: "1",
    generatedAt: model.meta.generatedAt,
    totalConditions: raw.extractions.reduce((n, e) => n + e.conditions.length, 0),
    totalErrors:     raw.extractions.reduce((n, e) => n + e.errors.length, 0),
    totalValidations:raw.extractions.reduce((n, e) => n + e.validations.length, 0),
    conditionsByFile: raw.extractions
      .filter(e => e.conditions.length > 0)
      .map(e => ({
        file:       e.file,
        language:   e.language,
        conditions: e.conditions.length,
        errors:     e.errors.length,
        validations: e.validations.length,
        sample:     e.conditions.slice(0, 5),
      }))
      .sort((a, b) => b.conditions - a.conditions)
      .slice(0, 100),
  });

  writeJson(join(config.output.raw, "dependencies.json"), {
    version: "1",
    generatedAt: model.meta.generatedAt,
    allImports: raw.extractions
      .flatMap(e => e.dependencies)
      .filter(d => d.to.startsWith("@carbon/") || d.to.startsWith("."))
      .slice(0, 2000),
    externalCalls: raw.extractions
      .flatMap(e => e.externalCalls)
      .slice(0, 500),
  });

  writeJson(join(config.output.raw, "ci.json"), {
    version: "1",
    generatedAt: model.meta.generatedAt,
    workflows: raw.ciWorkflows,
  });

  writeJson(join(config.output.raw, "builds.json"), {
    version: "1",
    generatedAt: model.meta.generatedAt,
    bazelTargets:    raw.buildTargets,
    cargoManifests:  raw.cargoManifests,
    npmManifests:    raw.npmManifests,
  });

  // 7. Write the main semantic model
  writeJson(join(config.output.semantic, "architecture.json"), model);

  // 8. Initialise human/overrides.json if it doesn't exist
  const overridesPath = join(config.output.human, "overrides.json");
  if (!existsSync(overridesPath)) {
    const emptyHuman: HumanModel = {
      version: "1",
      lastModified: new Date().toISOString(),
      overrides: [],
      additions: {},
    };
    writeJson(overridesPath, emptyHuman);
  }

  return model;
}

// ─── Human override application ───────────────────────────────────────────────

function loadHumanModel(humanDir: string): HumanModel {
  const path = join(humanDir, "overrides.json");
  if (!existsSync(path)) {
    return { version: "1", lastModified: "", overrides: [], additions: {} };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HumanModel;
  } catch {
    return { version: "1", lastModified: "", overrides: [], additions: {} };
  }
}

function applyEntityOverrides(
  entities: SemanticEntity[],
  human: HumanModel,
): SemanticEntity[] {
  const overrideMap = new Map<string, HumanOverride>(
    human.overrides
      .filter(o => o.targetKind === "entity")
      .map(o => [o.targetId, o])
  );

  return entities
    .filter(e => {
      const o = overrideMap.get(e.id);
      return !o || o.reviewStatus !== "rejected";
    })
    .map(e => {
      const o = overrideMap.get(e.id);
      if (!o || o.reviewStatus === "accepted" || !o.overrides) return e;
      // Apply field-level overrides
      return { ...e, ...o.overrides, id: e.id };
    });
}

function applyRuleOverrides(rules: SemanticRule[], human: HumanModel): SemanticRule[] {
  const overrideMap = new Map<string, HumanOverride>(
    human.overrides
      .filter(o => o.targetKind === "rule")
      .map(o => [o.targetId, o])
  );
  return rules
    .filter(r => {
      const o = overrideMap.get(r.id);
      return !o || o.reviewStatus !== "rejected";
    })
    .map(r => {
      const o = overrideMap.get(r.id);
      if (!o || !o.overrides) return r;
      return { ...r, ...o.overrides, id: r.id };
    });
}

function applyFlowOverrides(flows: SemanticFlow[], human: HumanModel): SemanticFlow[] {
  const overrideMap = new Map<string, HumanOverride>(
    human.overrides
      .filter(o => o.targetKind === "flow")
      .map(o => [o.targetId, o])
  );
  return flows
    .filter(f => {
      const o = overrideMap.get(f.id);
      return !o || o.reviewStatus !== "rejected";
    })
    .map(f => {
      const o = overrideMap.get(f.id);
      if (!o || !o.overrides) return f;
      return { ...f, ...o.overrides, id: f.id };
    });
}

function applyRelationshipOverrides(
  rels: SemanticRelationship[],
  human: HumanModel,
): SemanticRelationship[] {
  const overrideMap = new Map<string, HumanOverride>(
    human.overrides
      .filter(o => o.targetKind === "relationship")
      .map(o => [o.targetId, o])
  );
  return rels.filter(r => {
    const o = overrideMap.get(r.id);
    return !o || o.reviewStatus !== "rejected";
  });
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function countByLanguage(files: RawModel["files"]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    if (!f.ignored) counts[f.language] = (counts[f.language] ?? 0) + 1;
  }
  return counts;
}

function countByTier(files: RawModel["files"]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    if (!f.ignored && f.tier) counts[f.tier] = (counts[f.tier] ?? 0) + 1;
  }
  return counts;
}

// ─── JSON writer ─────────────────────────────────────────────────────────────

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}
