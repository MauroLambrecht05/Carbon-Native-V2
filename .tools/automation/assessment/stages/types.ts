/**
 * Core type definitions for the Carbon Native semantic assessment pipeline.
 *
 * These types represent the full semantic model — from raw extracted facts
 * through to the final architecture model the explorer consumes.
 *
 * Schema version: 1.0.0
 */

// ─── Evidence ────────────────────────────────────────────────────────────────

export type Confidence = "confirmed" | "inferred" | "uncertain" | "unknown";

export interface SourceEvidence {
  file: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  extractedBy?: string;
}

// ─── Raw Extraction Layer ─────────────────────────────────────────────────────

export interface ScannedFile {
  path: string;          // relative to repo root
  absolutePath: string;
  language: Language;
  size: number;
  hash: string;
  changed: boolean;      // vs last run
  tier?: RepotTier;
  product?: string;
  solution?: string;
  ignored: boolean;
  ignoreReason?: string;
}

export type Language =
  | "typescript" | "rust" | "zig" | "cpp" | "go" | "python"
  | "yaml" | "toml" | "json" | "markdown" | "shell" | "powershell"
  | "flatbuffers" | "bazel" | "starlark" | "dockerfile" | "unknown";

export type RepotTier =
  | "product" | "contracts" | "capabilities" | "infrastructure"
  | "integrations" | "interface" | "tooling" | "config" | "ci" | "labs";

// Raw conditional logic found in source
export interface RawCondition {
  condition: string;
  trueAction: string;
  falseAction?: string;
  nestedConditions?: RawCondition[];
  context: string;
  evidence: SourceEvidence;
}

// Raw import/export relationship
export interface RawDependency {
  from: string;    // file path
  to: string;      // module specifier or path
  kind: "import" | "export" | "re-export" | "dynamic-import" | "use" | "extern";
  symbols?: string[];
  evidence: SourceEvidence;
}

// Raw API surface item
export interface RawApiItem {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "const" | "trait" | "struct" | "macro";
  exported: boolean;
  async?: boolean;
  params?: string[];
  returnType?: string;
  docComment?: string;
  evidence: SourceEvidence;
}

// Raw error handling pattern
export interface RawErrorPattern {
  kind: "try-catch" | "result" | "option" | "throw" | "panic" | "unwrap" | "expect" | "question-mark";
  errorType?: string;
  handlingCode?: string;
  hasRetry?: boolean;
  hasFallback?: boolean;
  evidence: SourceEvidence;
}

// Raw validation pattern
export interface RawValidation {
  subject: string;
  condition: string;
  outcome: string;
  evidence: SourceEvidence;
}

// Raw configuration access
export interface RawConfigAccess {
  key: string;
  kind: "read" | "write" | "default" | "env-var";
  defaultValue?: string;
  evidence: SourceEvidence;
}

// Raw external call
export interface RawExternalCall {
  target: string;   // service name or URL pattern
  method?: string;
  kind: "http" | "ipc" | "ffi" | "db" | "file" | "network" | "webhook" | "s3" | "discord";
  async?: boolean;
  evidence: SourceEvidence;
}

// Extracted from a single file
export interface RawFileExtraction {
  file: string;
  language: Language;
  symbols: RawApiItem[];
  conditions: RawCondition[];
  dependencies: RawDependency[];
  errors: RawErrorPattern[];
  validations: RawValidation[];
  configAccesses: RawConfigAccess[];
  externalCalls: RawExternalCall[];
  comments: string[];
  extractionErrors: string[];
}

// CI pipeline step
export interface RawCiStep {
  name: string;
  run?: string;
  uses?: string;
  condition?: string;
  env?: Record<string, string>;
}

// CI job
export interface RawCiJob {
  id: string;
  name: string;
  runsOn: string | string[];
  needs?: string[];
  condition?: string;
  steps: RawCiStep[];
  outputs?: Record<string, string>;
  strategy?: { matrix?: unknown; failFast?: boolean };
}

// Full CI workflow
export interface RawCiWorkflow {
  file: string;
  name: string;
  triggers: string[];
  triggerConditions?: Record<string, unknown>;
  jobs: RawCiJob[];
  env?: Record<string, string>;
}

// Build target
export interface RawBuildTarget {
  name: string;
  kind: "binary" | "library" | "test" | "tool" | "bundle" | "installer" | "container";
  language: Language;
  sources?: string[];
  deps?: string[];
  features?: string[];
  file: string;
}

// Cargo manifest
export interface RawCargoManifest {
  file: string;
  packageName: string;
  version: string;
  edition?: string;
  bins: Array<{ name: string; path: string; requiredFeatures?: string[] }>;
  libs: Array<{ name: string; path?: string }>;
  features: Record<string, string[]>;
  dependencies: Record<string, { version?: string; path?: string; optional?: boolean; features?: string[] }>;
}

// Package.json manifest
export interface RawNpmManifest {
  file: string;
  name: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  description?: string;
}

// FlatBuffers schema item
export interface RawFlatbuffersSchema {
  file: string;
  namespace?: string;
  tables: string[];
  enums: string[];
  unions: string[];
  structs: string[];
  rpcs: string[];
}

// Full raw model produced by all extractors
export interface RawModel {
  version: "1";
  generatedAt: string;
  repositoryRoot: string;
  files: ScannedFile[];
  extractions: RawFileExtraction[];
  ciWorkflows: RawCiWorkflow[];
  buildTargets: RawBuildTarget[];
  cargoManifests: RawCargoManifest[];
  npmManifests: RawNpmManifest[];
  flatbuffersSchemas: RawFlatbuffersSchema[];
  analysisGaps: AnalysisGap[];
}

export interface AnalysisGap {
  file: string;
  reason: string;
  language?: string;
  impact: "high" | "medium" | "low";
}

// ─── Semantic Model Layer ─────────────────────────────────────────────────────

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

// A node in the semantic graph
export interface SemanticEntity {
  id: string;             // stable slug, e.g. "carbon-cli.project-creation"
  type: EntityType;
  name: string;
  shortName?: string;
  description: string;   // human-readable "what this is"
  purpose?: string;       // "why it exists"

  // Hierarchy
  parentId?: string;      // direct parent entity id
  childIds?: string[];

  // Behavioral properties
  howItWorks?: string;   // prose explanation of behavior
  conditions?: SemanticCondition[];
  outcomes?: SemanticOutcome[];

  // Cross-cutting
  technologies?: string[];
  languages?: Language[];
  configuration?: SemanticConfigItem[];

  // Quality
  confidence: Confidence;
  notes?: string;
  potentialIssues?: PotentialIssue[];
  unknowns?: string[];

  // Provenance
  evidence: SourceEvidence[];
  tags?: string[];
}

// A directed relationship between entities
export interface SemanticRelationship {
  id: string;
  from: string;          // entity id
  to: string;            // entity id
  relationship: RelationshipType;
  label?: string;        // human label
  condition?: string;    // when does this hold?
  confidence: Confidence;
  evidence: SourceEvidence[];
}

// A behavioral rule / check — first-class entity
export interface SemanticRule {
  id: string;
  name: string;
  kind: "rule" | "check" | "validation" | "guard" | "policy";
  context: string;        // which capability/module this belongs to
  condition: string;      // human-readable condition
  action: string;         // what happens
  outcome: string;        // result
  alternatives?: Array<{ condition: string; action: string }>;
  nestedRules?: SemanticRule[];
  confidence: Confidence;
  evidence: SourceEvidence[];
}

// A semantic flow (sequence of steps)
export interface SemanticFlow {
  id: string;
  name: string;
  description: string;
  trigger?: string;      // what starts this flow
  context: string;       // which entity owns it
  steps: FlowStep[];
  errorPaths?: FlowStep[];
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
  entityRef?: string;    // referenced entity id
  ruleRef?: string;
  evidence?: SourceEvidence[];
}

// A semantic condition (used in entities and rules)
export interface SemanticCondition {
  id: string;
  description: string;
  raw?: string;          // original code condition
  trueOutcome: string;
  falseOutcome?: string;
  nested?: SemanticCondition[];
  evidence: SourceEvidence;
}

export interface SemanticOutcome {
  description: string;
  kind: "success" | "failure" | "redirect" | "transform" | "notify" | "block";
  entityRef?: string;
}

export interface SemanticConfigItem {
  key: string;
  description?: string;
  defaultValue?: string;
  source?: string;
  affectsBehavior?: boolean;
  envVar?: string;
}

// Flagged potential issues (not bugs — things deserving review)
export interface PotentialIssue {
  kind:
    | "orphan-capability"
    | "missing-validation"
    | "missing-error-handling"
    | "duplicated-logic"
    | "circular-dependency"
    | "undocumented-behavior"
    | "contradiction"
    | "unreachable-branch"
    | "undocumented-config"
    | "inconsistent-behavior"
    | "bypass-architecture"
    | "missing-contract";
  description: string;
  severity: "high" | "medium" | "low";
  evidence?: SourceEvidence[];
}

// A contradiction between sources
export interface Contradiction {
  id: string;
  description: string;
  sourceA: { location: string; claim: string };
  sourceB: { location: string; claim: string };
  resolution?: string;
  evidence: SourceEvidence[];
}

// ─── Final Architecture Model ─────────────────────────────────────────────────

export interface ArchitectureModel {
  meta: {
    version: "1.0.0";
    schemaVersion: "1";
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

  // Indexes for fast lookup (built at load time by the explorer)
  indexes?: {
    byId?: Record<string, SemanticEntity>;
    byType?: Record<EntityType, string[]>;
    byTag?: Record<string, string[]>;
    children?: Record<string, string[]>;
    parents?: Record<string, string>;
  };
}

// ─── Human Overrides ─────────────────────────────────────────────────────────

export type ReviewStatus = "accepted" | "rejected" | "edited" | "ignored" | "pending";

export interface HumanOverride {
  id: string;
  targetId: string;      // entity/rule/flow/relationship id
  targetKind: "entity" | "rule" | "flow" | "relationship" | "potential-issue";
  reviewStatus: ReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  note?: string;

  // Field-level overrides
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

// ─── Coverage Report ─────────────────────────────────────────────────────────

export interface CoverageReport {
  version: "1";
  generatedAt: string;
  summary: {
    totalFiles: number;
    analyzedFiles: number;
    skippedFiles: number;
    ignoredFiles: number;
    coveragePercent: number;
  };
  byLanguage: Record<Language, { files: number; analyzed: number }>;
  entities: {
    products: number;
    solutions: number;
    capabilities: number;
    contracts: number;
    integrations: number;
    infrastructure: number;
    flows: number;
    rules: number;
    checks: number;
    decisions: number;
    errors: number;
    configurations: number;
    technologies: number;
  };
  confidence: {
    confirmed: number;
    inferred: number;
    uncertain: number;
    unknown: number;
  };
  analysisGaps: AnalysisGap[];
  reviewQueue: {
    unknowns: number;
    inferences: number;
    contradictions: number;
    potentialIssues: number;
    total: number;
  };
  skippedFiles: Array<{ file: string; reason: string }>;
}

// ─── Pipeline State ────────────────────────────────────────────────────────────

export type PipelineStage =
  | "scan" | "extract" | "interpret" | "resolve" | "model" | "report" | "serve";

export interface PipelineOptions {
  stage?: PipelineStage;
  full?: boolean;
  incremental?: boolean;
  serve?: boolean;
  config?: string;
  verbose?: boolean;
  repoRoot?: string;
}

export interface StageResult {
  stage: PipelineStage;
  success: boolean;
  duration: number;
  itemsProcessed: number;
  warnings: string[];
  errors: string[];
}
