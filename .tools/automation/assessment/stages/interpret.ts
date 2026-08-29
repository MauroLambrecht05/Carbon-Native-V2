/**
 * Stage 3 — Semantic Interpreter
 *
 * Transforms raw extracted evidence into a structured semantic model.
 * This is the core intelligence stage: it converts implementation facts
 * into system-behavior descriptions.
 *
 * Design principle: never invent — only describe what is observable,
 * and always mark confidence honestly.
 *
 * What this stage produces:
 *   - SemanticEntity nodes for every product, solution, module, capability, etc.
 *   - SemanticRule nodes for every meaningful conditional
 *   - SemanticFlow nodes for startup, build, CI, and key process flows
 *   - PotentialIssue flags where something looks suspicious
 *   - Contradiction flags where sources disagree
 */

import { join, dirname, basename } from "path";
import type {
  RawModel,
  RawFileExtraction,
  RawCiWorkflow,
  RawCiJob,
  RawCargoManifest,
  RawNpmManifest,
  RawBuildTarget,
  RawFlatbuffersSchema,
  RawCondition,
  RawErrorPattern,
  ScannedFile,
  SemanticEntity,
  SemanticRule,
  SemanticFlow,
  FlowStep,
  SemanticCondition,
  Contradiction,
  PotentialIssue,
  Confidence,
  EntityType,
  SourceEvidence,
  Language,
} from "./types.ts";

// ─── ID generation ────────────────────────────────────────────────────────────

let _seq = 0;
function nextId(prefix: string): string {
  return `${prefix}-${String(++_seq).padStart(4, "0")}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function stableId(type: string, name: string): string {
  return `${slug(type)}.${slug(name)}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function evidenceFromFile(file: string, line?: number): SourceEvidence {
  return { file, lineStart: line, extractedBy: "interpreter" };
}

function tierToEntityType(tier: string): EntityType {
  switch (tier) {
    case "product":       return "PRODUCT";
    case "contracts":     return "CONTRACT";
    case "capabilities":  return "CAPABILITY";
    case "infrastructure":return "INFRASTRUCTURE";
    case "integrations":  return "INTEGRATION";
    case "interface":     return "INTERFACE";
    default:              return "MODULE";
  }
}

function conditionToNaturalLanguage(cond: string): string {
  // Already humanized by extractor — minimal further cleanup
  return cond.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

/** Infer whether a condition represents a security/auth check */
function isAuthCondition(cond: string): boolean {
  return /\b(user|auth|token|session|credential|permission|role|access|login|logout|sign.?in|sign.?out|unauthori|forbidden|jwt|oauth)\b/i.test(cond);
}

/** Infer whether a condition is an error/failure guard */
function isErrorGuard(cond: string, action: string): boolean {
  return /\b(error|err|fail|invalid|null|undefined|empty|missing|not.?found)\b/i.test(cond) ||
         /\b(throw|panic|return\s+err|reject|bail)\b/i.test(action);
}

/** Infer whether a condition is a feature flag */
function isFeatureFlag(cond: string): boolean {
  return /\b(feature|flag|enable|disable|experimental|preview|beta)\b/i.test(cond) ||
         cond.includes("feature \"");
}

/** Infer whether a condition is environment-specific */
function isEnvCheck(cond: string): boolean {
  return /\b(production|staging|development|dev|prod|environment|env)\b/i.test(cond);
}

// ─── Product / Solution entity builders ──────────────────────────────────────

interface ProductInfo {
  name: string;
  description: string;
  languages: Language[];
  technologies: string[];
  purpose: string;
}

const PRODUCT_KNOWLEDGE: Record<string, ProductInfo> = {
  "carbon": {
    name: "Carbon Runtime",
    description: "The native runtime — two shipped binaries (carbon-mini and carbon-blitz) sharing one host layer. carbon-mini uses tiny-skia/fontdue/Taffy/rquickjs. carbon-blitz uses Stylo/Vello/wgpu.",
    languages: ["rust"],
    technologies: ["tiny-skia", "fontdue", "taffy", "rquickjs", "wgpu", "vello", "stylo", "tokio", "tao", "softbuffer"],
    purpose: "Execute Carbon applications at native speed with a minimal binary footprint.",
  },
  "carbon-cli": {
    name: "Carbon CLI",
    description: "The primary developer-facing command-line tool. Entry point for all developer workflows: run, build, bundle, publish, scaffold, plugin management.",
    languages: ["typescript"],
    technologies: ["bun", "vite", "babel"],
    purpose: "Give developers a single ergonomic entrypoint for all Carbon platform operations.",
  },
  "carbon-cloud": {
    name: "Carbon Cloud",
    description: "Build and release platform. Accepts a push, produces a signed OS installer and manages auto-update channels. Runs on Docker with PostgreSQL and MinIO.",
    languages: ["typescript"],
    technologies: ["docker", "postgres", "minio", "bun"],
    purpose: "Provide hosted CI/CD for Carbon apps: build queue, signing, distribution.",
  },
  "carbon-discord": {
    name: "Carbon Discord Bot",
    description: "Discord community bot built with discord.js. Sends structured notifications for releases, PR merges, and push digests.",
    languages: ["typescript"],
    technologies: ["discord.js", "bun"],
    purpose: "Keep the developer community informed about repository activity.",
  },
  "carbon-ext": {
    name: "Carbon Extension SDK",
    description: "Plugin SDK — C ABI header, Zig package definition, and templates for native plugin authors.",
    languages: ["zig", "typescript"],
    technologies: ["zig", "c-abi"],
    purpose: "Enable third-party native plugin development against the Carbon plugin ABI.",
  },
  "carbon-vscode": {
    name: "Carbon VS Code Extension",
    description: ".ctsx syntax highlighting for Visual Studio Code.",
    languages: ["typescript"],
    technologies: ["vscode-extension-api"],
    purpose: "Provide editor support for Carbon's .ctsx template syntax.",
  },
  "carbon-website": {
    name: "Carbon Website",
    description: "Public marketing website built with React + Vite.",
    languages: ["typescript"],
    technologies: ["react", "vite"],
    purpose: "Public-facing presence for the Carbon Native platform.",
  },
};

const SOLUTION_TIER_KNOWLEDGE: Record<string, { description: string; purpose: string }> = {
  "contracts":      { description: "Shared agreements between tiers that must not drift. Includes FlatBuffers schemas, TypeScript types, and Rust readers.", purpose: "Ensure cross-language type safety and prevent API drift." },
  "capabilities":   { description: "Domain logic — what Carbon can do. Grouped into cloud, distribution, plugin, rendering, and tooling categories.", purpose: "Contain all business logic, isolated from products." },
  "infrastructure": { description: "Vendor-neutral technical services: ports and adapters for OS access, logging, process management, plugin hosting.", purpose: "Provide stable, product-agnostic technical foundations." },
  "integrations":   { description: "Named outside technologies: Vite, Babel, QuickJS, xterm, three.js.", purpose: "Integrate specific vendor technologies without leaking them into business logic." },
  "interface":      { description: "How application code and developers reach the runtime: CLI kernel, React/Solid reconcilers, stdlib API and bindings.", purpose: "Expose the runtime surface to app code and tooling." },
};

// ─── Main Interpreter ─────────────────────────────────────────────────────────

export interface InterpretResult {
  entities:       SemanticEntity[];
  rules:          SemanticRule[];
  flows:          SemanticFlow[];
  contradictions: Contradiction[];
  potentialIssues: PotentialIssue[];
}

export function interpret(raw: RawModel): InterpretResult {
  const entities:        SemanticEntity[]  = [];
  const rules:           SemanticRule[]    = [];
  const flows:           SemanticFlow[]    = [];
  const contradictions:  Contradiction[]   = [];
  const potentialIssues: PotentialIssue[]  = [];

  // ── 1. System root entity ─────────────────────────────────────────────────

  entities.push({
    id:          "system.carbon-native",
    type:        "SYSTEM",
    name:        "Carbon Native V2",
    description: "High-performance polyglot native execution platform. Two shipped runtimes (carbon-mini, carbon-blitz), a developer CLI, a cloud build platform, and supporting tooling. Built in Rust, TypeScript, Zig, and C++.",
    purpose:     "Enable developers to build and ship high-performance native applications using web-familiar patterns.",
    technologies: ["rust", "typescript", "zig", "cpp", "bazel", "bun", "flatbuffers"],
    languages:   ["rust", "typescript", "zig", "cpp"],
    confidence:  "confirmed",
    evidence:    [evidenceFromFile("README.md"), evidenceFromFile(".config/_identity.json")],
    tags:        ["system", "root"],
  });

  // ── 2. Products ───────────────────────────────────────────────────────────

  const products = new Set<string>();
  for (const file of raw.files) {
    if (file.tier === "product" && file.product) products.add(file.product);
  }

  for (const productName of products) {
    const knowledge = PRODUCT_KNOWLEDGE[productName];
    const productFiles = raw.files.filter(f => f.product === productName);
    const productEvidence = productFiles.slice(0, 3).map(f => evidenceFromFile(f.path));

    entities.push({
      id:           stableId("product", productName),
      type:         "PRODUCT",
      name:         knowledge?.name ?? productName,
      shortName:    productName,
      description:  knowledge?.description ?? `Product: ${productName}`,
      purpose:      knowledge?.purpose,
      parentId:     "system.carbon-native",
      technologies: knowledge?.technologies,
      languages:    knowledge?.languages ?? detectLanguagesForProduct(productName, raw.files),
      confidence:   "confirmed",
      evidence:     productEvidence,
      tags:         ["product"],
    });
  }

  // ── 3. Solution tiers ─────────────────────────────────────────────────────

  const solutionTiers = ["contracts", "capabilities", "infrastructure", "integrations", "interface"] as const;
  for (const tier of solutionTiers) {
    const k = SOLUTION_TIER_KNOWLEDGE[tier]!;
    entities.push({
      id:          stableId("solution", tier),
      type:        "SOLUTION",
      name:        `solutions/${tier}`,
      shortName:   tier,
      description: k.description,
      purpose:     k.purpose,
      parentId:    "system.carbon-native",
      confidence:  "confirmed",
      evidence:    [evidenceFromFile("solutions/README.md")],
      tags:        ["solution", tier],
    });
  }

  // ── 4. Solution modules ───────────────────────────────────────────────────

  interpretSolutionModules(raw, entities);

  // ── 5. Technologies ───────────────────────────────────────────────────────

  interpretTechnologies(raw, entities);

  // ── 6. Build systems ──────────────────────────────────────────────────────

  interpretBuildSystems(raw, entities, flows);

  // ── 7. CI Pipelines ───────────────────────────────────────────────────────

  for (const workflow of raw.ciWorkflows) {
    interpretCiWorkflow(workflow, entities, flows, rules);
  }

  // ── 8. Contracts ──────────────────────────────────────────────────────────

  interpretContracts(raw, entities);

  // ── 9. Semantic rules from conditional logic ──────────────────────────────

  interpretConditions(raw, rules, potentialIssues);

  // ── 10. Error handling patterns ───────────────────────────────────────────

  interpretErrorPatterns(raw, rules, potentialIssues);

  // ── 11. Configuration ─────────────────────────────────────────────────────

  interpretConfiguration(raw, entities);

  // ── 12. External integrations ─────────────────────────────────────────────

  interpretExternalIntegrations(raw, entities);

  // ── 13. Capabilities deep dive ────────────────────────────────────────────

  interpretCapabilities(raw, entities, rules, flows);

  // ── 14. Feature flags ─────────────────────────────────────────────────────

  interpretFeatureFlags(raw, entities);

  // ── 15. Host boundary ─────────────────────────────────────────────────────

  interpretHostBoundary(raw, entities, rules);

  // ── 16. Contradiction detection ───────────────────────────────────────────

  detectContradictions(raw, contradictions);

  // ── 17. Potential issues ──────────────────────────────────────────────────

  detectPotentialIssues(raw, entities, rules, potentialIssues);

  return { entities, rules, flows, contradictions, potentialIssues };
}

// ─── Solution module interpreter ─────────────────────────────────────────────

function interpretSolutionModules(raw: RawModel, entities: SemanticEntity[]): void {
  const modules = new Map<string, { tier: string; files: ScannedFile[] }>();

  for (const file of raw.files) {
    if (!file.solution || file.ignored) continue;
    const key = `${file.tier}/${file.solution}`;
    if (!modules.has(key)) modules.set(key, { tier: file.tier ?? "", files: [] });
    modules.get(key)!.files.push(file);
  }

  for (const [key, { tier, files }] of modules) {
    const parts = key.split("/");
    const solution = parts[1] ?? key;
    const parentId = stableId("solution", tier);
    const sampleFile = files[0];

    // Determine languages
    const langs = [...new Set(files.map(f => f.language).filter(l => l !== "unknown" && l !== "markdown" && l !== "json"))];

    // Try to find a README for description
    const readmeFile = files.find(f => f.path.endsWith("README.md"));
    const readmeExtraction = readmeFile
      ? raw.extractions.find(e => e.file === readmeFile.path)
      : null;
    const description = readmeExtraction?.comments?.[0] ?? `Solution module: ${solution}`;

    entities.push({
      id:          stableId(tier, solution),
      type:        tierToEntityType(tier),
      name:        solution,
      description,
      parentId,
      languages:   langs as Language[],
      confidence:  "confirmed",
      evidence:    sampleFile ? [evidenceFromFile(sampleFile.path)] : [],
      tags:        [tier, "module"],
    });
  }
}

// ─── Technology entities ──────────────────────────────────────────────────────

const KNOWN_TECHNOLOGIES: Array<{
  id: string; name: string; description: string;
  detectIn: string[]; role: string;
}> = [
  { id: "tech.bazel",       name: "Bazel 7.4.1",       description: "Hermetic, reproducible build system. The single entrypoint for all builds and tests.", detectIn: [".bazelversion", "MODULE.bazel", "BUILD.bazel"], role: "Build system" },
  { id: "tech.bun",         name: "Bun 1.3.10",        description: "JavaScript runtime and package manager. Runs all TypeScript tooling and serves as the npm client.", detectIn: [".config/package.json", "bun.lock"], role: "JS runtime and package manager" },
  { id: "tech.rust",        name: "Rust 1.88.0",        description: "Systems programming language. Used for all runtime binaries, rendering engine, and distribution tooling.", detectIn: [".tools/orchestration/bazel/cargo/Cargo.toml"], role: "Runtime and systems layer" },
  { id: "tech.zig",         name: "Zig 0.13.0",         description: "Systems language used for plugin ABI boundaries and the extension SDK.", detectIn: ["products/carbon-ext/build.zig"], role: "Plugin and extension layer" },
  { id: "tech.flatbuffers", name: "FlatBuffers 24.3.25", description: "Zero-copy IDL and serialization library. Defines cross-language contracts (.fbs schemas).", detectIn: ["MODULE.bazel"], role: "Contract and serialization layer" },
  { id: "tech.docker",      name: "Docker",             description: "Containerization for Carbon Cloud. The control plane and Linux worker run in Docker.", detectIn: ["products/carbon-cloud/docker-compose.yml"], role: "Cloud infrastructure" },
  { id: "tech.postgres",    name: "PostgreSQL 16",      description: "Relational database for Carbon Cloud.", detectIn: ["products/carbon-cloud/docker-compose.yml"], role: "Cloud data storage" },
  { id: "tech.minio",       name: "MinIO",              description: "S3-compatible object store for build artifacts in Carbon Cloud.", detectIn: ["products/carbon-cloud/docker-compose.yml"], role: "Artifact storage" },
  { id: "tech.vite",        name: "Vite 5",             description: "Frontend build tool and dev server. Used to bundle Carbon app source code.", detectIn: [".config/package.json"], role: "App bundler" },
  { id: "tech.babel",       name: "Babel 7",            description: "JavaScript/TypeScript transformer. Used for JSX → scene graph transforms and carbon-css compilation.", detectIn: [".config/package.json"], role: "Code transformation" },
  { id: "tech.react",       name: "React 18",           description: "UI library. Carbon provides a mini-react reconciler that maps React components to the native scene graph.", detectIn: [".config/package.json"], role: "UI renderer" },
  { id: "tech.solid",       name: "Solid.js",           description: "Reactive UI library. Carbon provides a Solid reconciler for native rendering.", detectIn: [".config/package.json"], role: "UI renderer" },
  { id: "tech.quickjs",     name: "QuickJS (rquickjs)", description: "Embedded JavaScript engine. Executes app JavaScript inside the Rust runtime via the rquickjs-core fork.", detectIn: ["solutions/integrations/javascript/quickjs"], role: "JS engine in runtime" },
  { id: "tech.go",          name: "Go 1.22.0",          description: "Registered in MODULE.bazel. Minor tooling role.", detectIn: ["MODULE.bazel"], role: "Tooling" },
  { id: "tech.github-actions", name: "GitHub Actions",  description: "CI/CD platform. Runs structure checks, full test matrix, and release pipeline.", detectIn: [".github/workflows"], role: "CI/CD" },
];

function interpretTechnologies(raw: RawModel, entities: SemanticEntity[]): void {
  const filePaths = new Set(raw.files.map(f => f.path));

  for (const tech of KNOWN_TECHNOLOGIES) {
    const found = tech.detectIn.some(p =>
      filePaths.has(p) || raw.files.some(f => f.path.startsWith(p))
    );
    if (!found) continue;

    entities.push({
      id:          tech.id,
      type:        "TECHNOLOGY",
      name:        tech.name,
      description: tech.description,
      purpose:     tech.role,
      parentId:    "system.carbon-native",
      confidence:  "confirmed",
      evidence:    tech.detectIn
        .filter(p => filePaths.has(p) || raw.files.some(f => f.path.startsWith(p)))
        .slice(0, 2)
        .map(p => evidenceFromFile(p)),
      tags:        ["technology"],
    });
  }
}

// ─── Build system interpreter ─────────────────────────────────────────────────

function interpretBuildSystems(raw: RawModel, entities: SemanticEntity[], flows: SemanticFlow[]): void {
  // Bazel build entity
  entities.push({
    id:          "build.bazel-workspace",
    type:        "BUILD",
    name:        "Bazel Workspace Build",
    description: "The unified build system. Every CI job and every developer workflow invokes Bazel. Bun and Cargo are compiler drivers underneath Bazel, not standalone build systems.",
    purpose:     "Ensure hermetic, reproducible builds across all languages and all OSes.",
    parentId:    "system.carbon-native",
    howItWorks:  "Bazel reads MODULE.bazel for external dependencies, then processes BUILD.bazel targets. Bun is invoked via a custom hermetic toolchain (.tools/orchestration/bazel/bun). Cargo is invoked via the cargo launcher in .tools/orchestration/bazel/cargo/defs.bzl, which sets RUSTUP_TOOLCHAIN and CARGO_TARGET_DIR.",
    configuration: [
      { key: "RUSTUP_TOOLCHAIN", defaultValue: "1.88.0", affectsBehavior: true, description: "Pinned Rust toolchain version" },
      { key: "CARGO_TARGET_DIR", defaultValue: ".tools/orchestration/bazel/cargo/target", affectsBehavior: true },
      { key: "CARGO_INCREMENTAL", defaultValue: "0", description: "Disabled for reproducibility" },
      { key: "CARGO_BUILD_RUSTFLAGS", defaultValue: "--remap-path-prefix=.=carbon-native" },
      { key: "disk_cache", defaultValue: "~/.cache/bazel_carbon_v2" },
    ],
    technologies: ["bazel", "bun", "rust", "zig"],
    confidence:  "confirmed",
    evidence:    [evidenceFromFile(".bazelrc"), evidenceFromFile("MODULE.bazel"), evidenceFromFile(".bazelversion")],
    tags:        ["build", "toolchain"],
  });

  // Cargo build entity
  entities.push({
    id:          "build.cargo-workspace",
    type:        "BUILD",
    name:        "Cargo Workspace",
    description: "Rust dependency and compilation workspace. Manifest at .tools/orchestration/bazel/cargo/Cargo.toml. All Rust crates in products/ and solutions/ are members.",
    purpose:     "Manage all Rust dependencies and compile the runtime binaries.",
    parentId:    "build.bazel-workspace",
    howItWorks:  "Cargo.toml at .tools/orchestration/bazel/cargo/ declares the workspace members. CARGO_TARGET_DIR is set to target/ beside the manifest. Root .cargo/config.toml declares this path so `cargo` commands typed in any subdirectory find the correct target dir.",
    confidence:  "confirmed",
    evidence:    [evidenceFromFile(".cargo/config.toml")],
    tags:        ["build", "rust"],
  });

  // Runtime build flow
  const runtimeBuildSteps: FlowStep[] = [
    { id: "rbs-1", order: 1, name: "Feature selection", description: "Select backend: --features mini or --features blitz. Must be explicit — no default features.", kind: "decision", evidence: [evidenceFromFile("products/carbon/Cargo.toml")] },
    { id: "rbs-2", order: 2, name: "Dependency resolution", description: "Cargo resolves the dependency graph. Backend-exclusive deps are optional — selecting mini never compiles blitz's stack.", kind: "action" },
    { id: "rbs-3", order: 3, name: "Build script execution", description: "build.rs runs. For snapshot feature: sets /DYNAMICBASE:NO linker flag to fix base address for ASLR-off snapshot pointers.", kind: "action", evidence: [evidenceFromFile("products/carbon/build.rs")] },
    { id: "rbs-4", order: 4, name: "Compilation", description: "rustc compiles the crate with selected features. dist profile: opt-level z, fat LTO, 1 codegen unit.", kind: "action" },
    { id: "rbs-5", order: 5, name: "Linking", description: "Linker produces the final binary. carbon-mini or carbon-blitz.", kind: "action" },
    { id: "rbs-6", order: 6, name: "Artifact", description: "Binary emitted to CARGO_TARGET_DIR/<target>/<profile>/", kind: "end" },
  ];

  flows.push({
    id:          "flow.runtime-build",
    name:        "Runtime Build",
    description: "How carbon-mini (or carbon-blitz) is compiled from source.",
    trigger:     "bazel build //products/carbon:mini (or :blitz)",
    context:     "build.cargo-workspace",
    steps:       runtimeBuildSteps,
    confidence:  "confirmed",
    evidence:    [evidenceFromFile("products/carbon/Cargo.toml"), evidenceFromFile(".github/workflows/release.yml")],
  });

  // CLI build flow
  const cliBuildSteps: FlowStep[] = [
    { id: "cbs-1", order: 1, name: "Install JS deps", description: "bun install --cwd .config --frozen-lockfile; create node_modules junction at repo root.", kind: "action", evidence: [evidenceFromFile(".config/package.json")] },
    { id: "cbs-2", order: 2, name: "TypeScript compilation", description: "bazel run //products/carbon-cli:carbon -- <command> invokes Bun which transpiles TypeScript on-the-fly.", kind: "action" },
    { id: "cbs-3", order: 3, name: "Path alias resolution", description: "@carbon/* aliases resolved via .config/tsconfig.base.json path mappings. No bun workspaces — pure tsconfig paths.", kind: "action", evidence: [evidenceFromFile(".config/tsconfig.base.json")] },
    { id: "cbs-4", order: 4, name: "Command dispatch", description: "CLI registry lazily loads the requested command from presentation/commands/.", kind: "action", evidence: [evidenceFromFile("products/carbon-cli/composition/registry.ts")] },
  ];

  flows.push({
    id:          "flow.cli-invocation",
    name:        "CLI Invocation",
    description: "How the Carbon CLI resolves and executes a developer command.",
    trigger:     "bazel run //products/carbon-cli:carbon -- <command>",
    context:     stableId("product", "carbon-cli"),
    steps:       cliBuildSteps,
    confidence:  "confirmed",
    evidence:    [evidenceFromFile("products/carbon-cli/main.ts")],
  });
}

// ─── CI Workflow interpreter ──────────────────────────────────────────────────

function interpretCiWorkflow(
  workflow: RawCiWorkflow,
  entities: SemanticEntity[],
  flows: SemanticFlow[],
  rules: SemanticRule[],
): void {
  const workflowId = stableId("ci", workflow.name);

  const conditionSummaries: string[] = [];
  for (const job of workflow.jobs) {
    if (job.condition) conditionSummaries.push(`Job "${job.name}" runs when: ${job.condition}`);
    for (const step of job.steps) {
      if (step.condition) conditionSummaries.push(`Step "${step.name}" runs when: ${step.condition}`);
    }
  }

  entities.push({
    id:          workflowId,
    type:        "CI_PIPELINE",
    name:        workflow.name,
    description: `GitHub Actions workflow: ${workflow.name}. Triggers: ${workflow.triggers.join(", ")}. Jobs: ${workflow.jobs.map(j => j.name).join(", ")}.`,
    parentId:    "system.carbon-native",
    howItWorks:  conditionSummaries.join("\n") || undefined,
    configuration: workflow.env
      ? Object.entries(workflow.env).map(([k, v]) => ({ key: k, defaultValue: v, affectsBehavior: true }))
      : undefined,
    technologies: ["github-actions"],
    confidence:  "confirmed",
    evidence:    [evidenceFromFile(workflow.file)],
    tags:        ["ci", "pipeline"],
  });

  // Flow steps from jobs
  const flowSteps: FlowStep[] = workflow.jobs.map((job, idx) => ({
    id:          `${workflowId}-step-${idx}`,
    order:       idx + 1,
    name:        job.name,
    description: `Runs on: ${job.runsOn}. Steps: ${job.steps.map(s => s.name).join(", ")}.`,
    kind:        "action" as const,
    condition:   job.condition,
    outcomes:    job.needs?.length
      ? [{ description: `Requires: ${job.needs.join(", ")}` }]
      : undefined,
    evidence:    [evidenceFromFile(workflow.file)],
  }));

  flows.push({
    id:          `flow.ci.${slug(workflow.name)}`,
    name:        `CI: ${workflow.name}`,
    description: `CI pipeline for ${workflow.name}. Triggered by: ${workflow.triggers.join(", ")}.`,
    trigger:     workflow.triggers.join(", "),
    context:     workflowId,
    steps:       flowSteps,
    confidence:  "confirmed",
    evidence:    [evidenceFromFile(workflow.file)],
  });

  // Rules from conditional steps
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (!step.condition) continue;
      rules.push({
        id:         nextId("rule"),
        name:       `CI: ${step.name}`,
        kind:       "check",
        context:    workflowId,
        condition:  step.condition,
        action:     step.run ? `Run: ${step.run.slice(0, 100)}` : (step.uses ? `Use: ${step.uses}` : "execute step"),
        outcome:    "Step executes or is skipped",
        confidence: "confirmed",
        evidence:   [evidenceFromFile(workflow.file)],
      });
    }
  }
}

// ─── Contract interpreter ─────────────────────────────────────────────────────

const CONTRACT_KNOWLEDGE: Record<string, { description: string; provides: string }> = {
  "core":         { description: "Primitive FlatBuffers schemas. Foundation for all cross-language data structures.", provides: "core.fbs — base types" },
  "app":          { description: "carbon.toml application manifest schema, TypeScript types, Rust reader, and errors.", provides: "CarbonManifest type, config.rs parser, ConfigError" },
  "plugin":       { description: "Extension-point registry, C ABI definition, plugin manifest, and permissions model.", provides: "C ABI header, PluginManifest, ExtensionPoints.zig" },
  "host":         { description: "Host-layer API, events, and IPC FlatBuffers schemas.", provides: "api.fbs, events.fbs, ipc.fbs" },
  "runtime":      { description: "Host-boundary registry: 139 Rust→JS and 34 JS→Rust function declarations.", provides: "host-boundary.toml — the FFI contract no compiler sees" },
  "security":     { description: "Keyring shape, minisign signature format, and byte-length constants.", provides: "Keyring type, SignatureFormat" },
  "versioning":   { description: "FlatBuffers compatibility triple schema.", provides: "versioning.fbs" },
  "update":       { description: "UpdateManifest type — what a release announces to an installed app.", provides: "UpdateManifest" },
  "distribution": { description: "InstallerTarget type — which installer formats exist and where each may be built.", provides: "InstallerTarget" },
  "toolchain":    { description: "Toolchain version matrix. CI and bootstrap scripts read this.", provides: "Toolchain type with pinned versions" },
};

function interpretContracts(raw: RawModel, entities: SemanticEntity[]): void {
  const contractFiles = raw.files.filter(f => f.tier === "contracts");
  const contractNames = [...new Set(contractFiles.map(f => f.solution).filter(Boolean))];

  for (const name of contractNames) {
    if (!name) continue;
    const k = CONTRACT_KNOWLEDGE[name];
    const filesForContract = contractFiles.filter(f => f.solution === name);

    entities.push({
      id:          stableId("contract", name),
      type:        "CONTRACT",
      name:        `contracts/${name}`,
      shortName:   name,
      description: k?.description ?? `Contract package: ${name}`,
      purpose:     k ? `Provides: ${k.provides}` : undefined,
      parentId:    stableId("solution", "contracts"),
      languages:   [...new Set(filesForContract.map(f => f.language).filter(l => l !== "unknown"))] as Language[],
      confidence:  "confirmed",
      evidence:    filesForContract.slice(0, 2).map(f => evidenceFromFile(f.path)),
      tags:        ["contract"],
    });
  }
}

// ─── Conditional logic → Rules ────────────────────────────────────────────────

function interpretConditions(
  raw: RawModel,
  rules: SemanticRule[],
  potentialIssues: PotentialIssue[],
): void {
  for (const extraction of raw.extractions) {
    for (const cond of extraction.conditions) {
      // Skip trivial or extremely short conditions
      if (cond.condition.length < 3) continue;
      // Skip compiler-noise conditions
      if (cond.condition === "unknown" || cond.condition === "true" || cond.condition === "false") continue;

      const kind = classifyConditionKind(cond.condition, cond.trueAction);

      const rule: SemanticRule = {
        id:         nextId("rule"),
        name:       deriveRuleName(cond.condition, cond.trueAction, extraction.file),
        kind,
        context:    deriveContext(extraction.file),
        condition:  conditionToNaturalLanguage(cond.condition),
        action:     cond.trueAction,
        outcome:    deriveOutcome(cond.trueAction, cond.falseAction),
        confidence: "confirmed",
        evidence:   [cond.evidence],
      };

      if (cond.falseAction && cond.falseAction !== "skip / else branch") {
        rule.alternatives = [{ condition: `NOT (${cond.condition})`, action: cond.falseAction }];
      }

      rules.push(rule);

      // Flag potential missing error handling
      if (kind === "guard" && !cond.falseAction) {
        // Guard with no else — that's fine, but check if the condition is always ignored
      }
    }
  }
}

function classifyConditionKind(condition: string, action: string): SemanticRule["kind"] {
  if (isAuthCondition(condition)) return "guard";
  if (isErrorGuard(condition, action)) return "guard";
  if (isFeatureFlag(condition)) return "check";
  if (isEnvCheck(condition)) return "policy";
  if (/\b(valid|invalid|missing|required|must|should)\b/i.test(condition)) return "validation";
  return "rule";
}

function deriveRuleName(condition: string, action: string, file: string): string {
  const context = basename(file).replace(/\.[^.]+$/, "");
  const condShort = condition.slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  return `${condShort} → ${action.slice(0, 30)}`;
}

function deriveContext(file: string): string {
  const parts = file.split("/");
  // Find meaningful segment
  if (parts[0] === "products") return parts[1] ?? file;
  if (parts[0] === "solutions") return `${parts[1] ?? "solutions"}/${parts[2] ?? ""}`;
  if (parts[0] === ".github") return "ci";
  if (parts[0] === ".tools") return "tooling";
  return parts[0] ?? file;
}

function deriveOutcome(trueAction: string, falseAction?: string): string {
  if (falseAction) return `${trueAction} OR ${falseAction}`;
  return trueAction;
}

// ─── Error patterns → Rules ───────────────────────────────────────────────────

function interpretErrorPatterns(
  raw: RawModel,
  rules: SemanticRule[],
  potentialIssues: PotentialIssue[],
): void {
  // Find files with throws but no try/catch — potential unhandled errors
  const fileErrorMap = new Map<string, { throws: number; catches: number }>();

  for (const extraction of raw.extractions) {
    const throws  = extraction.errors.filter(e => e.kind === "throw").length;
    const catches = extraction.errors.filter(e => e.kind === "try-catch").length;
    const panics  = extraction.errors.filter(e => e.kind === "panic").length;
    const unwraps = extraction.errors.filter(e => e.kind === "unwrap").length;

    if (throws > 0 || panics > 0) {
      fileErrorMap.set(extraction.file, { throws: throws + panics, catches });
    }

    // Excessive unwraps without error handling — potential issue
    if (unwraps > 5 && catches === 0) {
      potentialIssues.push({
        kind:        "missing-error-handling",
        description: `${extraction.file} contains ${unwraps} .unwrap() calls with no error handling. Panics may be unhandled in production.`,
        severity:    "medium",
        evidence:    extraction.errors.filter(e => e.kind === "unwrap").slice(0, 3).map(e => e.evidence),
      });
    }

    // Model try/catch patterns as rules
    for (const err of extraction.errors) {
      if (err.kind === "try-catch" && err.handlingCode) {
        rules.push({
          id:         nextId("rule"),
          name:       `Error handling in ${basename(extraction.file)}`,
          kind:       "rule",
          context:    deriveContext(extraction.file),
          condition:  `operation in ${basename(extraction.file)} throws`,
          action:     err.handlingCode.slice(0, 150),
          outcome:    err.hasFallback ? "fallback executed" : (err.hasRetry ? "operation retried" : "error propagated"),
          confidence: "confirmed",
          evidence:   [err.evidence],
        });
      }
    }
  }
}

// ─── Configuration interpreter ────────────────────────────────────────────────

function interpretConfiguration(raw: RawModel, entities: SemanticEntity[]): void {
  // Aggregate env vars by product/solution
  const envVarsByContext = new Map<string, Set<string>>();

  for (const extraction of raw.extractions) {
    const context = deriveContext(extraction.file);
    if (!envVarsByContext.has(context)) envVarsByContext.set(context, new Set());
    for (const cfg of extraction.configAccesses) {
      if (cfg.kind === "env-var") {
        envVarsByContext.get(context)!.add(cfg.key);
      }
    }
  }

  // Find parent entities and annotate their config
  for (const [context, vars] of envVarsByContext) {
    if (vars.size === 0) continue;
    // We record this as a CONFIGURATION entity
    if (vars.size > 3) {
      entities.push({
        id:          stableId("config", context),
        type:        "CONFIGURATION",
        name:        `Configuration: ${context}`,
        shortName:   context,
        description: `Environment variables and configuration consumed by ${context}: ${[...vars].join(", ")}.`,
        parentId:    "system.carbon-native",
        configuration: [...vars].map(k => ({ key: k, kind: "env-var", affectsBehavior: true })),
        confidence:  "inferred",
        evidence:    [],
        tags:        ["configuration"],
      } as SemanticEntity);
    }
  }

  // Well-known configuration entities
  entities.push({
    id:          "config.features",
    type:        "FEATURE_FLAG",
    name:        "Feature Flags",
    description: "Runtime feature flags defined in .config/features.json: simd (AVX2/NEON), zeroCopyBuffer (FlatBuffers shared memory), zigPluginRuntime (C-ABI dynamic plugin host), rustAsyncTransport (Tokio), ipcRpcChannel.",
    parentId:    "system.carbon-native",
    configuration: [
      { key: "simd",              description: "AVX2/NEON SIMD acceleration", affectsBehavior: true },
      { key: "zeroCopyBuffer",    description: "FlatBuffers shared-memory zero-copy", affectsBehavior: true },
      { key: "zigPluginRuntime",  description: "C-ABI dynamic plugin host", affectsBehavior: true },
      { key: "rustAsyncTransport",description: "Tokio async transport", affectsBehavior: true },
      { key: "ipcRpcChannel",     description: "gRPC/Protobuf/IPC channel", affectsBehavior: true },
    ],
    confidence:  "confirmed",
    evidence:    [evidenceFromFile(".config/features.json")],
    tags:        ["configuration", "feature-flags"],
  });

  // Build profiles
  entities.push({
    id:          "config.build-profiles",
    type:        "CONFIGURATION",
    name:        "Build Profiles",
    description: "Three build profiles from .config/build.json: debug (opt 0, ASAN/UBSAN, dbg symbols), release (opt 3, LTO, stripped), profile (opt 2, profiling enabled). Dist profile in Cargo: opt z, fat LTO, 1 codegen unit.",
    parentId:    "build.bazel-workspace",
    configuration: [
      { key: "debug",   description: "opt-level 0, ASAN, UBSAN, full debug info", affectsBehavior: true },
      { key: "release", description: "opt-level 3, LTO, stripped", affectsBehavior: true },
      { key: "profile", description: "opt-level 2, profiling zones enabled", affectsBehavior: true },
      { key: "dist",    description: "Cargo: opt-level z, fat LTO, 1 codegen unit — published binaries", affectsBehavior: true },
    ],
    confidence:  "confirmed",
    evidence:    [evidenceFromFile(".config/build.json"), evidenceFromFile(".github/workflows/release.yml")],
    tags:        ["configuration", "build"],
  });
}

// ─── External integrations ────────────────────────────────────────────────────

function interpretExternalIntegrations(raw: RawModel, entities: SemanticEntity[]): void {
  const allExternalCalls = raw.extractions.flatMap(e => e.externalCalls);

  const discordCalls = allExternalCalls.filter(c => c.kind === "discord");
  if (discordCalls.length > 0) {
    entities.push({
      id:          "integration.discord",
      type:        "EXTERNAL_SYSTEM",
      name:        "Discord",
      description: "Discord webhook integration. Receives notifications for releases, PR merges, and push digests.",
      parentId:    "system.carbon-native",
      confidence:  "confirmed",
      evidence:    discordCalls.slice(0, 3).map(c => c.evidence),
      tags:        ["integration", "external"],
    });
  }

  const s3Calls = allExternalCalls.filter(c => c.kind === "s3");
  if (s3Calls.length > 0) {
    entities.push({
      id:          "integration.s3-update-bucket",
      type:        "EXTERNAL_SYSTEM",
      name:        "AWS S3 Update Bucket",
      description: "AWS S3 bucket that stores signed release artifacts and update manifests. The 10% rollout channel uses this.",
      parentId:    stableId("product", "carbon-cloud"),
      confidence:  "confirmed",
      evidence:    s3Calls.slice(0, 2).map(c => c.evidence),
      tags:        ["integration", "external", "deployment"],
    });
  }

  // Slack (from release.yml)
  if (raw.ciWorkflows.some(w => w.env && "SLACK_WEBHOOK" in w.env || w.jobs.some(j => j.steps.some(s => s.condition?.includes("SLACK_WEBHOOK"))))) {
    entities.push({
      id:          "integration.slack",
      type:        "EXTERNAL_SYSTEM",
      name:        "Slack",
      description: "Slack webhook for release status notifications. Always fires (success + failure).",
      parentId:    "system.carbon-native",
      confidence:  "confirmed",
      evidence:    [evidenceFromFile(".github/workflows/release.yml")],
      tags:        ["integration", "external"],
    });
  }
}

// ─── Capabilities deep dive ───────────────────────────────────────────────────

const CAPABILITY_KNOWLEDGE: Record<string, { name: string; description: string; kind: string }> = {
  "bundling":      { name: "App Bundling",       description: "Transforms app source into a runnable bundle using Bun.build with Vite integration.", kind: "service" },
  "scaffolding":   { name: "Project Scaffolding", description: "Generates a working Carbon project from a name and preset.", kind: "service" },
  "packaging":     { name: "Installer Packaging", description: "Emits OS-specific installer definitions: NSIS (.nsi), WiX (.wxs), Debian control. Definitions only — Bazel builds the actual installers.", kind: "service" },
  "publishing":    { name: "Release Publishing",  description: "Announces a release and ships artifacts to the update bucket. Includes carbon-delta for binary delta generation.", kind: "service" },
  "signing":       { name: "Artifact Signing",    description: "Signs artifacts using minisign. Verifies signatures before update acceptance.", kind: "service" },
  "updating":      { name: "Auto-Updater",        description: "A/B partition state machine with crash-counter rollback. Verifies update manifests before applying.", kind: "engine" },
  "billing":       { name: "Cloud Billing",       description: "Carbon Cloud billing domain.", kind: "service" },
  "orchestration": { name: "Build Orchestration", description: "Carbon Cloud build queue management.", kind: "service" },
  "worker":        { name: "Cloud Worker",        description: "Carbon Cloud build worker — executes builds in isolated containers.", kind: "service" },
  "identity":      { name: "Cloud Identity",      description: "Carbon Cloud account and identity management.", kind: "service" },
  "audio":         { name: "Web Audio Engine",    description: "Web Audio API implementation. Opt-in via 'audio' feature. Target for Phase 2 plugin migration.", kind: "engine" },
  "imaging":       { name: "Image Loading",       description: "Image decoding (PNG, JPEG, etc.). Opt-in via 'image' feature. Target for Phase 2 plugin migration.", kind: "engine" },
  "layout":        { name: "Layout Engine",       description: "Scene graph + Taffy CSS layout + CSS value parsing. The carbon-layout crate.", kind: "engine" },
  "math":          { name: "Fast Math Library",   description: "Vector3, Matrix4, Quaternion, Box3, Frustum, Color — pure-Rust three.js math classes. Zero cost if app never calls __cm_register_math().", kind: "library" },
  "painting":      { name: "Paint Engine",        description: "tiny-skia paint dispatch, Canvas2D API, SVG, blur, CSS parse. The carbon-paint crate.", kind: "engine" },
  "snapshot":      { name: "Heap Snapshot",       description: "Heap snapshot/restore for cold-start exec-skip. Requires ASLR disabled (snapshot feature sets /DYNAMICBASE:NO).", kind: "engine" },
  "text":          { name: "Text Renderer",       description: "fontdue-based text rendering. The carbon-text-renderer crate.", kind: "engine" },
  "registry":      { name: "Plugin Registry",     description: "Parses Zig extension-point registry and renders C/Rust/TypeScript bindings.", kind: "service" },
  "lifecycle":     { name: "Plugin Lifecycle",    description: "Plugin authoring, building, installation, and preflight checks.", kind: "service" },
  "sdk":           { name: "Plugin SDK",          description: "Zig SDK implementation for native plugin authors.", kind: "service" },
};

function interpretCapabilities(
  raw: RawModel,
  entities: SemanticEntity[],
  rules: SemanticRule[],
  flows: SemanticFlow[],
): void {
  const capFiles = raw.files.filter(f => f.tier === "capabilities");
  const capNames = [...new Set(capFiles.map(f => f.solution).filter(Boolean))];

  for (const cap of capNames) {
    if (!cap) continue;
    const k = CAPABILITY_KNOWLEDGE[cap];
    if (k) {
      // Find the parent category
      const capFile = capFiles.find(f => f.solution === cap);
      const pathParts = capFile?.path.split("/") ?? [];
      const categoryIdx = pathParts.indexOf("capabilities") + 1;
      const category = categoryIdx > 0 ? (pathParts[categoryIdx] ?? "capabilities") : "capabilities";

      entities.push({
        id:          stableId("capability", cap),
        type:        "CAPABILITY",
        name:        k.name,
        shortName:   cap,
        description: k.description,
        purpose:     `Kind: ${k.kind}`,
        parentId:    stableId("solution", "capabilities"),
        languages:   detectLanguagesForSolution(cap, raw.files),
        confidence:  "confirmed",
        evidence:    capFiles.filter(f => f.solution === cap).slice(0, 2).map(f => evidenceFromFile(f.path)),
        tags:        ["capability", k.kind, category],
      });
    }
  }

  // App startup flow (inferred from runtime structure)
  flows.push({
    id:          "flow.app-startup",
    name:        "Application Startup",
    description: "How Carbon bootstraps an app from the command `carbon run`.",
    trigger:     "bazel run //products/carbon-cli:carbon -- run <app-dir>",
    context:     stableId("product", "carbon"),
    steps: [
      { id: "as-1", order: 1, name: "CLI receives run command", description: "Carbon CLI parses the app directory argument.", kind: "action" },
      { id: "as-2", order: 2, name: "Read carbon.toml", description: "WorkspaceLayout reads carbon.toml. CarbonManifest is parsed and validated against the schema.", kind: "action", entityRef: stableId("contract", "app") },
      { id: "as-3", order: 3, name: "Bundle app source", description: "Bundling capability invokes Bun.build with Vite plugins. CSS, JSX, and imports are transformed.", kind: "action", entityRef: stableId("capability", "bundling") },
      { id: "as-4", order: 4, name: "Start runtime binary", description: "CLI spawns carbon-mini (or carbon-blitz) with the bundle path.", kind: "action", entityRef: stableId("product", "carbon") },
      { id: "as-5", order: 5, name: "Runtime initialisation", description: "Runtime registers all 139 host functions, initialises QuickJS engine, loads app bundle.", kind: "action" },
      { id: "as-6", order: 6, name: "Create window", description: "tao creates the OS window. Renderer initialises (softbuffer for mini, wgpu for blitz).", kind: "action" },
      { id: "as-7", order: 7, name: "Execute app bundle", description: "QuickJS executes the bundled JavaScript. App's render function is called.", kind: "action" },
      { id: "as-8", order: 8, name: "App running", description: "Run loop handles events, calls into Rust host functions for OS operations, paints frames.", kind: "end" },
    ],
    confidence:  "inferred",
    evidence:    [evidenceFromFile("products/carbon-cli/main.ts"), evidenceFromFile("products/carbon/Cargo.toml")],
  });
}

// ─── Feature flags → entities ─────────────────────────────────────────────────

function interpretFeatureFlags(raw: RawModel, entities: SemanticEntity[]): void {
  // Cargo features from runtime Cargo.toml
  const cargoManifests = raw.cargoManifests.filter(m => m.packageName === "carbon-runtime");

  for (const manifest of cargoManifests) {
    for (const [featureName, deps] of Object.entries(manifest.features)) {
      if (featureName === "default") continue;

      entities.push({
        id:          stableId("feature", featureName),
        type:        "FEATURE_FLAG",
        name:        `Runtime Feature: ${featureName}`,
        shortName:   featureName,
        description: featureFlagDescription(featureName, deps),
        parentId:    stableId("product", "carbon"),
        confidence:  "confirmed",
        evidence:    [evidenceFromFile(manifest.file)],
        tags:        ["feature-flag", "rust-feature"],
      });
    }
  }
}

function featureFlagDescription(name: string, deps: string[]): string {
  const descriptions: Record<string, string> = {
    "mini":     "Selects the carbon-mini backend: tiny-skia paint, fontdue text, Taffy layout, rquickjs JS engine.",
    "blitz":    "Selects the carbon-blitz backend: Stylo + Vello + wgpu GPU-accelerated rendering.",
    "gpu":      "GPU canvas support. Parked — not actively used. Code paths remain compiled-out via #[cfg(feature)].",
    "image":    "Image loading (PNG, JPEG, etc.) via carbon-image crate. Off by default saves ~0.8 MB.",
    "audio":    "Web Audio API via carbon-audio crate. Off by default saves ~0.4 MB.",
    "profiling":"Tracy profiler zones for frame-level analysis. Zero overhead when disabled.",
    "updater":  "A/B partition auto-updater with crash-counter rollback.",
    "snapshot": "Heap snapshot for cold-start exec-skip. Enables /DYNAMICBASE:NO linker flag.",
  };
  return descriptions[name] ?? `Enables: ${deps.join(", ")}`;
}

// ─── Host boundary ────────────────────────────────────────────────────────────

function interpretHostBoundary(raw: RawModel, entities: SemanticEntity[], rules: SemanticRule[]): void {
  entities.push({
    id:          "boundary.host",
    type:        "BOUNDARY",
    name:        "Host Boundary (FFI)",
    description: "The string-literal FFI contract between Rust and JavaScript. 139 functions Rust installs for JS to call (__cm_* host functions), 34 that JS installs for Rust to call. Declared in contracts/runtime/registry/host-boundary.toml. No compiler verifies either side.",
    purpose:     "Enable bidirectional communication between the QuickJS JS engine and the Rust host layer.",
    parentId:    stableId("contract", "runtime"),
    howItWorks:  "JS calls host functions by string name via __cm_invoke(). Rust registers handlers at startup via carbon_os::register_all(). The host-boundary.toml registry is the single source of truth — check_host_boundary.py verifies both directions.",
    confidence:  "confirmed",
    evidence:    [evidenceFromFile("solutions/contracts/runtime/registry/host-boundary.toml"), evidenceFromFile(".github/CONTRIBUTING.md")],
    tags:        ["boundary", "ffi", "contract"],
  });

  // Rule: renaming a host function without updating the registry
  rules.push({
    id:         nextId("rule"),
    name:       "Host Function Registration",
    kind:       "check",
    context:    "boundary.host",
    condition:  "host function name in Rust source does not match host-boundary.toml",
    action:     "check_host_boundary.py test fails — CI blocked",
    outcome:    "Build fails before the mismatch can reach production",
    confidence: "confirmed",
    evidence:   [evidenceFromFile(".github/CONTRIBUTING.md")],
  });
}

// ─── Contradiction detection ──────────────────────────────────────────────────

function detectContradictions(raw: RawModel, contradictions: Contradiction[]): void {
  // Check README vs actual file tree for key claims
  const readmeExtraction = raw.extractions.find(e => e.file === "README.md");
  if (!readmeExtraction) return;

  // labs/ should be excluded from //...
  const labsFiles = raw.files.filter(f => f.path.startsWith("labs/") && !f.ignored);
  if (labsFiles.length > 0) {
    // This is expected — check if it's correctly excluded from Bazel
    const labsBazelFile = labsFiles.find(f => f.path === "labs/BUILD.bazel");
    // No contradiction if labs is simply present but not in //...
  }

  // Check: CONTRIBUTING says "Bazel is the entrypoint" — verify no shell-invoked cargo
  const shellWithDirectCargo = raw.extractions.filter(
    e => (e.language === "shell" || e.language === "powershell") &&
    e.externalCalls.some(c => String(c.target).includes("cargo "))
  );
  if (shellWithDirectCargo.length > 0) {
    contradictions.push({
      id:          nextId("contradiction"),
      description: "CONTRIBUTING.md states 'Bazel is the entrypoint' but some shell scripts invoke cargo directly.",
      sourceA:     { location: ".github/CONTRIBUTING.md", claim: "Bazel is the entrypoint — there is no task runner and no wrapper script." },
      sourceB:     { location: shellWithDirectCargo.map(e => e.file).join(", "), claim: "cargo is invoked directly (expected for cross-compile / release scripts)" },
      resolution:  "The release.yml workflow uses cargo-zigbuild directly for cross-compilation — this is intentional and documented.",
      evidence:    shellWithDirectCargo.flatMap(e => e.externalCalls.slice(0, 1).map(c => c.evidence)),
    });
  }
}

// ─── Potential issue detection ────────────────────────────────────────────────

function detectPotentialIssues(
  raw: RawModel,
  entities: SemanticEntity[],
  rules: SemanticRule[],
  potentialIssues: PotentialIssue[],
): void {
  // Products with no contracts usage
  const contractEntities = entities.filter(e => e.type === "CONTRACT").map(e => e.id);
  const productEntities  = entities.filter(e => e.type === "PRODUCT");

  // Check: very large files with no extraction
  for (const gap of raw.analysisGaps) {
    if (gap.impact === "high") {
      potentialIssues.push({
        kind:        "undocumented-behavior",
        description: `Analysis gap in ${gap.file}: ${gap.reason}. Behavior in this file is not represented in the semantic model.`,
        severity:    "medium",
        evidence:    [{ file: gap.file, extractedBy: "potential-issue-detector" }],
      });
    }
  }

  // Check: Rust files with many unwraps
  const rustFilesWithManyUnwraps = raw.extractions
    .filter(e => e.language === "rust")
    .filter(e => e.errors.filter(err => err.kind === "unwrap").length > 10);

  for (const file of rustFilesWithManyUnwraps) {
    const count = file.errors.filter(e => e.kind === "unwrap").length;
    potentialIssues.push({
      kind:        "missing-error-handling",
      description: `${file.file} has ${count} .unwrap() calls. Any of these can panic at runtime if the value is None/Err.`,
      severity:    "medium",
      evidence:    [{ file: file.file, extractedBy: "potential-issue-detector" }],
    });
  }

  // Check: GPU feature is parked
  potentialIssues.push({
    kind:        "orphan-capability",
    description: "The 'gpu' feature in products/carbon is declared but empty. GPU canvas support is parked at labs/gpu-canvas and currently has no active path into the main build.",
    severity:    "low",
    evidence:    [evidenceFromFile("products/carbon/Cargo.toml")],
  });

  // Check: image and audio features are off by default, Phase 2 migration pending
  potentialIssues.push({
    kind:        "undocumented-behavior",
    description: "The 'image' and 'audio' features are off by default. Phase 2 is planned to migrate them to plugins, but this migration is not yet complete. Apps requiring images or audio must explicitly opt in via Cargo features.",
    severity:    "low",
    evidence:    [evidenceFromFile("products/carbon/Cargo.toml")],
  });

  // Check: CI_WINDOWS_ONLY toggle
  potentialIssues.push({
    kind:        "undocumented-config",
    description: "The CI_WINDOWS_ONLY GitHub Actions repository variable controls whether CI runs on ubuntu/macos in addition to windows. Branch protection on main only requires windows-latest checks. If CI_WINDOWS_ONLY is false but branch protection is not widened, Linux/macOS regressions can merge silently.",
    severity:    "high",
    evidence:    [evidenceFromFile(".github/workflows/ci.yml"), evidenceFromFile(".github/CONTRIBUTING.md")],
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function detectLanguagesForProduct(productName: string, files: ScannedFile[]): Language[] {
  const langs = new Set<Language>();
  for (const f of files) {
    if (f.product === productName && f.language !== "unknown") langs.add(f.language);
  }
  return [...langs].filter(l => !["markdown", "json", "yaml", "toml"].includes(l as string));
}

function detectLanguagesForSolution(solution: string, files: ScannedFile[]): Language[] {
  const langs = new Set<Language>();
  for (const f of files) {
    if (f.solution === solution && f.language !== "unknown") langs.add(f.language);
  }
  return [...langs].filter(l => !["markdown", "json", "yaml", "toml"].includes(l as string));
}
