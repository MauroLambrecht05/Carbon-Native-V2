// Mirrors stages/types.ts — kept in sync manually.
// The explorer only consumes the ArchitectureModel; it never needs to import
// Node/Bun modules, so we keep a clean client-side copy here.

export type Confidence = "confirmed" | "inferred" | "uncertain" | "unknown";

export type EntityType =
  | "SYSTEM" | "PRODUCT" | "SOLUTION" | "MODULE" | "CAPABILITY"
  | "CONTRACT" | "INTERFACE" | "INTEGRATION" | "INFRASTRUCTURE"
  | "EXTERNAL_SYSTEM" | "DATA" | "CONFIGURATION" | "DECISION"
  | "RULE" | "CHECK" | "VALIDATION" | "ERROR" | "FLOW" | "PROCESS"
  | "BUILD" | "CI_PIPELINE" | "DEPLOYMENT" | "ENVIRONMENT"
  | "TECHNOLOGY" | "TOOLCHAIN" | "FEATURE_FLAG" | "BOUNDARY";

export type RelationshipType =
  | "CONTAINS" | "USES" | "PROVIDES" | "REQUIRES" | "IMPLEMENTS"
  | "REFERENCES" | "CALLS" | "TRIGGERS" | "LEADS_TO" | "DEPENDS_ON"
  | "VALIDATES" | "CHECKS" | "DECIDES" | "PRODUCES" | "CONSUMES"
  | "READS" | "WRITES" | "SENDS" | "RECEIVES" | "TRANSFORMS"
  | "DEPLOYS" | "BUILDS" | "TESTS" | "CONFIGURES" | "INTEGRATES_WITH"
  | "FALLS_BACK_TO" | "FAILS_WITH" | "ENFORCES" | "EXTENDS" | "OVERRIDES";

export interface SourceEvidence {
  file: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  extractedBy?: string;
}

export interface SemanticConfigItem {
  key: string;
  description?: string;
  defaultValue?: string;
  source?: string;
  affectsBehavior?: boolean;
  envVar?: string;
}

export interface PotentialIssue {
  kind: string;
  description: string;
  severity: "high" | "medium" | "low";
  evidence?: SourceEvidence[];
}

export interface SemanticCondition {
  id: string;
  description: string;
  raw?: string;
  trueOutcome: string;
  falseOutcome?: string;
  nested?: SemanticCondition[];
  evidence: SourceEvidence;
}

export interface SemanticEntity {
  id: string;
  type: EntityType;
  name: string;
  shortName?: string;
  description: string;
  purpose?: string;
  parentId?: string;
  childIds?: string[];
  howItWorks?: string;
  conditions?: SemanticCondition[];
  technologies?: string[];
  languages?: string[];
  configuration?: SemanticConfigItem[];
  confidence: Confidence;
  notes?: string;
  potentialIssues?: PotentialIssue[];
  unknowns?: string[];
  evidence: SourceEvidence[];
  tags?: string[];
}

export interface SemanticRelationship {
  id: string;
  from: string;
  to: string;
  relationship: RelationshipType;
  label?: string;
  condition?: string;
  confidence: Confidence;
  evidence: SourceEvidence[];
}

export interface SemanticRule {
  id: string;
  name: string;
  kind: "rule" | "check" | "validation" | "guard" | "policy";
  context: string;
  condition: string;
  action: string;
  outcome: string;
  alternatives?: Array<{ condition: string; action: string }>;
  nestedRules?: SemanticRule[];
  confidence: Confidence;
  evidence: SourceEvidence[];
}

export interface FlowStep {
  id: string;
  order: number;
  name: string;
  description: string;
  kind: "action" | "decision" | "check" | "wait" | "error" | "end";
  condition?: string;
  outcomes?: Array<{ condition?: string; nextStepId?: string; description: string }>;
  entityRef?: string;
  ruleRef?: string;
  evidence?: SourceEvidence[];
}

export interface SemanticFlow {
  id: string;
  name: string;
  description: string;
  trigger?: string;
  context: string;
  steps: FlowStep[];
  errorPaths?: FlowStep[];
  confidence: Confidence;
  evidence: SourceEvidence[];
}

export interface Contradiction {
  id: string;
  description: string;
  sourceA: { location: string; claim: string };
  sourceB: { location: string; claim: string };
  resolution?: string;
  evidence: SourceEvidence[];
}

export interface ArchitectureModel {
  meta: {
    version: string;
    schemaVersion: string;
    generatedAt: string;
    repositoryRoot: string;
    analysisDepth: string;
    toolVersion: string;
  };
  entities: SemanticEntity[];
  relationships: SemanticRelationship[];
  rules: SemanticRule[];
  flows: SemanticFlow[];
  contradictions: Contradiction[];
  potentialIssues: PotentialIssue[];
}

// Human override types
export type ReviewStatus = "accepted" | "rejected" | "edited" | "ignored" | "pending";

export interface HumanOverride {
  id: string;
  targetId: string;
  targetKind: "entity" | "rule" | "flow" | "relationship" | "potential-issue";
  reviewStatus: ReviewStatus;
  reviewedAt?: string;
  note?: string;
  overrides?: Partial<SemanticEntity & SemanticRule & SemanticFlow>;
}

export interface HumanModel {
  version: "1";
  lastModified: string;
  overrides: HumanOverride[];
  additions: {
    entities?: SemanticEntity[];
    rules?: SemanticRule[];
    flows?: SemanticFlow[];
    relationships?: SemanticRelationship[];
  };
}

// Built indexes
export interface ModelIndexes {
  byId: Map<string, SemanticEntity>;
  byType: Map<EntityType, SemanticEntity[]>;
  byTag: Map<string, SemanticEntity[]>;
  children: Map<string, SemanticEntity[]>;
  parents: Map<string, SemanticEntity>;
  relsByFrom: Map<string, SemanticRelationship[]>;
  relsByTo: Map<string, SemanticRelationship[]>;
  rulesByContext: Map<string, SemanticRule[]>;
  flowsByContext: Map<string, SemanticFlow[]>;
}

export function buildIndexes(model: ArchitectureModel): ModelIndexes {
  const byId      = new Map<string, SemanticEntity>();
  const byType    = new Map<EntityType, SemanticEntity[]>();
  const byTag     = new Map<string, SemanticEntity[]>();
  const children  = new Map<string, SemanticEntity[]>();
  const parents   = new Map<string, SemanticEntity>();
  const relsByFrom = new Map<string, SemanticRelationship[]>();
  const relsByTo   = new Map<string, SemanticRelationship[]>();
  const rulesByContext = new Map<string, SemanticRule[]>();
  const flowsByContext = new Map<string, SemanticFlow[]>();

  for (const e of model.entities) {
    byId.set(e.id, e);

    const typeList = byType.get(e.type) ?? [];
    typeList.push(e);
    byType.set(e.type, typeList);

    for (const tag of (e.tags ?? [])) {
      const tagList = byTag.get(tag) ?? [];
      tagList.push(e);
      byTag.set(tag, tagList);
    }

    if (e.parentId) {
      const childList = children.get(e.parentId) ?? [];
      childList.push(e);
      children.set(e.parentId, childList);
    }
  }

  // Build parent lookup
  for (const [parentId, childList] of children) {
    const parent = byId.get(parentId);
    if (parent) {
      for (const child of childList) parents.set(child.id, parent);
    }
  }

  for (const r of model.relationships) {
    const fromList = relsByFrom.get(r.from) ?? [];
    fromList.push(r);
    relsByFrom.set(r.from, fromList);

    const toList = relsByTo.get(r.to) ?? [];
    toList.push(r);
    relsByTo.set(r.to, toList);
  }

  for (const rule of model.rules) {
    const list = rulesByContext.get(rule.context) ?? [];
    list.push(rule);
    rulesByContext.set(rule.context, list);
  }

  for (const flow of model.flows) {
    const list = flowsByContext.get(flow.context) ?? [];
    list.push(flow);
    flowsByContext.set(flow.context, list);
  }

  return { byId, byType, byTag, children, parents, relsByFrom, relsByTo, rulesByContext, flowsByContext };
}

// Search helpers
export function searchModel(
  model: ArchitectureModel,
  indexes: ModelIndexes,
  query: string,
): { entities: SemanticEntity[]; rules: SemanticRule[]; flows: SemanticFlow[] } {
  if (!query.trim()) return { entities: [], rules: [], flows: [] };

  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  function scoreText(text: string): number {
    const t = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (t === term) score += 10;
      else if (t.startsWith(term)) score += 5;
      else if (t.includes(term)) score += 2;
    }
    return score;
  }

  function scoreEntity(e: SemanticEntity): number {
    return scoreText(e.name) * 3 +
      scoreText(e.description) +
      scoreText(e.purpose ?? "") +
      scoreText(e.type) +
      (e.tags ?? []).reduce((n, t) => n + scoreText(t), 0);
  }

  function scoreRule(r: SemanticRule): number {
    return scoreText(r.name) * 3 +
      scoreText(r.condition) * 2 +
      scoreText(r.action) +
      scoreText(r.outcome) +
      scoreText(r.context);
  }

  function scoreFlow(f: SemanticFlow): number {
    return scoreText(f.name) * 3 +
      scoreText(f.description) +
      scoreText(f.trigger ?? "");
  }

  const entities = model.entities
    .map(e => ({ e, score: scoreEntity(e) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(x => x.e);

  const rules = model.rules
    .map(r => ({ r, score: scoreRule(r) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map(x => x.r);

  const flows = model.flows
    .map(f => ({ f, score: scoreFlow(f) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(x => x.f);

  return { entities, rules, flows };
}

// Trace path between two entities using BFS
export function tracePath(
  fromId: string,
  toId: string,
  indexes: ModelIndexes,
): string[] | null {
  if (fromId === toId) return [fromId];

  const visited = new Set<string>([fromId]);
  const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const outRels = indexes.relsByFrom.get(current.id) ?? [];
    const inRels  = indexes.relsByTo.get(current.id) ?? [];

    for (const rel of [...outRels, ...inRels]) {
      const nextId = rel.from === current.id ? rel.to : rel.from;
      if (visited.has(nextId)) continue;
      const newPath = [...current.path, nextId];
      if (nextId === toId) return newPath;
      visited.add(nextId);
      queue.push({ id: nextId, path: newPath });
    }

    if (queue.length > 5000) break; // Safety
  }
  return null;
}
