/**
 * Stage 4 — Relationship Resolver
 *
 * Takes the semantic entities, rules, and flows produced by the interpreter
 * and builds the relationship graph between them.
 *
 * Relationships are derived from:
 *   1. File-level import/dependency facts from the raw model
 *   2. Known architectural rules (products depend on solutions, etc.)
 *   3. Capability→contract relationships via tsconfig paths
 *   4. Parent/child hierarchy (already set via parentId)
 *   5. CI pipeline → product relationships
 *   6. Build system → product relationships
 *
 * Every relationship carries evidence and confidence.
 * Only meaningful behavioral relationships are preserved — not every import.
 */

import type {
  InterpretResult,
} from "./interpret.ts";
import type {
  RawModel,
  SemanticRelationship,
  SemanticEntity,
  SemanticRule,
  SemanticFlow,
  Confidence,
  SourceEvidence,
  RelationshipType,
} from "./types.ts";

// ─── ID counter ───────────────────────────────────────────────────────────────

let _seq = 0;
function nextId(): string {
  return `rel-${String(++_seq).padStart(5, "0")}`;
}

function evidenceFromFile(file: string, line?: number): SourceEvidence {
  return { file, lineStart: line, extractedBy: "resolver" };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function stableId(type: string, name: string): string {
  return `${slug(type)}.${slug(name)}`;
}

// ─── Main Resolver ────────────────────────────────────────────────────────────

export function resolve(
  interpreted: InterpretResult,
  raw: RawModel,
): SemanticRelationship[] {
  const relationships: SemanticRelationship[] = [];
  const entityIds = new Set(interpreted.entities.map(e => e.id));

  function add(
    from: string,
    to: string,
    rel: RelationshipType,
    opts: {
      label?: string;
      condition?: string;
      confidence?: Confidence;
      evidence?: SourceEvidence[];
    } = {},
  ): void {
    if (!entityIds.has(from) || !entityIds.has(to)) return;
    if (from === to) return;
    relationships.push({
      id:           nextId(),
      from,
      to,
      relationship: rel,
      label:        opts.label,
      condition:    opts.condition,
      confidence:   opts.confidence ?? "confirmed",
      evidence:     opts.evidence ?? [],
    });
  }

  // ── 1. Hierarchy (parent→child CONTAINS) ─────────────────────────────────

  for (const entity of interpreted.entities) {
    if (entity.parentId && entityIds.has(entity.parentId)) {
      add(entity.parentId, entity.id, "CONTAINS", {
        evidence: entity.evidence.slice(0, 1),
      });
    }
  }

  // ── 2. Products DEPEND_ON solutions ──────────────────────────────────────

  const PRODUCT_SOLUTION_DEPS: Array<[string, string, string]> = [
    ["carbon-cli",   "bundling",      "CLI uses bundling capability to build apps"],
    ["carbon-cli",   "scaffolding",   "CLI uses scaffolding to create new projects"],
    ["carbon-cli",   "packaging",     "CLI uses packaging to produce OS installers"],
    ["carbon-cli",   "publishing",    "CLI uses publishing to ship releases"],
    ["carbon-cli",   "signing",       "CLI uses signing to sign artifacts"],
    ["carbon-cli",   "updating",      "CLI uses updating for A/B partition management"],
    ["carbon-cli",   "app",           "CLI reads carbon.toml via contracts/app"],
    ["carbon-cli",   "distribution",  "CLI uses installer target definitions"],
    ["carbon-cli",   "toolchain",     "CLI validates toolchain versions"],
    ["carbon",       "layout",        "Runtime composes the layout engine"],
    ["carbon",       "painting",      "Runtime composes the paint engine"],
    ["carbon",       "text",          "Runtime composes the text renderer"],
    ["carbon",       "math",          "Runtime uses fast math via __cm_register_math()"],
    ["carbon",       "snapshot",      "Runtime supports heap snapshot cold-start"],
    ["carbon",       "audio",         "Runtime optionally includes Web Audio (feature-gated)"],
    ["carbon",       "imaging",       "Runtime optionally includes image loading (feature-gated)"],
    ["carbon",       "runtime",       "Runtime implements the host-boundary contract"],
    ["carbon",       "host",          "Runtime implements host API/events/IPC"],
    ["carbon",       "plugin",        "Runtime hosts native plugins via plugin-host"],
    ["carbon-cloud", "billing",       "Cloud uses billing capability"],
    ["carbon-cloud", "orchestration", "Cloud uses orchestration capability"],
    ["carbon-cloud", "worker",        "Cloud uses worker capability"],
    ["carbon-cloud", "identity",      "Cloud uses identity capability"],
    ["carbon-cloud", "signing",       "Cloud signs built artifacts"],
    ["carbon-cloud", "publishing",    "Cloud publishes to update bucket"],
    ["carbon-ext",   "plugin",        "Extension SDK exposes plugin capability contracts"],
    ["carbon-ext",   "sdk",           "Extension SDK is built from plugin/sdk capability"],
  ];

  for (const [product, dep, label] of PRODUCT_SOLUTION_DEPS) {
    const productId = stableId("product", product);

    // Try capability first, then contract
    const depId =
      entityIds.has(stableId("capability", dep)) ? stableId("capability", dep) :
      entityIds.has(stableId("contract", dep))   ? stableId("contract", dep) :
      entityIds.has(stableId("solution", dep))   ? stableId("solution", dep) :
      null;

    if (depId) {
      add(productId, depId, "DEPENDS_ON", {
        label,
        confidence: "confirmed",
        evidence:   [evidenceFromFile("README.md")],
      });
    }
  }

  // ── 3. Interface layer relationships ─────────────────────────────────────

  // Interface can DEPEND_ON anything
  const interfaceDeps: Array<[string, string]> = [
    ["interface", "contracts"],
    ["interface", "capabilities"],
    ["interface", "infrastructure"],
    ["interface", "integrations"],
  ];

  for (const [from, to] of interfaceDeps) {
    add(
      stableId("solution", from),
      stableId("solution", to),
      "DEPENDS_ON",
      { confidence: "confirmed", evidence: [evidenceFromFile("solutions/README.md")] },
    );
  }

  // ── 4. Capabilities → contracts/infrastructure ────────────────────────────

  const CAPABILITY_CONTRACT_DEPS: Array<[string, string]> = [
    ["bundling",    "app"],
    ["scaffolding", "app"],
    ["packaging",   "distribution"],
    ["publishing",  "update"],
    ["signing",     "security"],
    ["updating",    "update"],
    ["updating",    "security"],
    ["registry",    "plugin"],
    ["lifecycle",   "plugin"],
    ["sdk",         "plugin"],
  ];

  for (const [cap, contract] of CAPABILITY_CONTRACT_DEPS) {
    const capId      = stableId("capability", cap);
    const contractId = stableId("contract", contract);
    add(capId, contractId, "IMPLEMENTS", {
      confidence: "confirmed",
      evidence:   [evidenceFromFile("solutions/README.md")],
    });
  }

  // ── 5. Build system relationships ─────────────────────────────────────────

  const buildId = "build.bazel-workspace";

  // Bazel BUILDS every product
  for (const entity of interpreted.entities.filter(e => e.type === "PRODUCT")) {
    add(buildId, entity.id, "BUILDS", {
      confidence: "confirmed",
      evidence:   [evidenceFromFile("MODULE.bazel")],
    });
  }

  // Cargo workspace BUILDS the runtime
  add("build.cargo-workspace", stableId("product", "carbon"), "BUILDS", {
    confidence: "confirmed",
    evidence:   [evidenceFromFile(".tools/orchestration/bazel/cargo/Cargo.toml")],
  });

  // ── 6. CI pipelines → products ────────────────────────────────────────────

  const ciEntities = interpreted.entities.filter(e => e.type === "CI_PIPELINE");

  for (const ci of ciEntities) {
    if (ci.name.toLowerCase().includes("release")) {
      // Release pipeline builds all products and deploys
      for (const product of interpreted.entities.filter(e => e.type === "PRODUCT")) {
        if (["carbon", "carbon-cli"].includes(product.shortName ?? "")) {
          add(ci.id, product.id, "BUILDS", {
            label:     "Release build",
            confidence: "confirmed",
            evidence:   [evidenceFromFile(".github/workflows/release.yml")],
          });
        }
      }
      add(ci.id, "integration.s3-update-bucket", "DEPLOYS", {
        condition: "All build-matrix jobs succeed",
        confidence: "confirmed",
        evidence:   [evidenceFromFile(".github/workflows/release.yml")],
      });
    }

    if (ci.name.toLowerCase().includes("ci")) {
      add(ci.id, buildId, "TRIGGERS", {
        confidence: "confirmed",
        evidence:   [evidenceFromFile(".github/workflows/ci.yml")],
      });
    }

    // Notification pipelines → Discord/Slack
    if (ci.name.toLowerCase().includes("notify") || ci.name.toLowerCase().includes("release")) {
      if (entityIds.has("integration.discord")) {
        add(ci.id, "integration.discord", "SENDS", {
          confidence: "confirmed",
          evidence:   [evidenceFromFile(ci.evidence[0]?.file ?? ".github/workflows")],
        });
      }
    }

    if (entityIds.has("integration.slack")) {
      if (ci.name.toLowerCase().includes("release")) {
        add(ci.id, "integration.slack", "SENDS", {
          condition:  "always (success and failure)",
          confidence: "confirmed",
          evidence:   [evidenceFromFile(".github/workflows/release.yml")],
        });
      }
    }
  }

  // ── 7. Technology → product/solution USES ─────────────────────────────────

  const TECH_USES: Array<[string, string, string]> = [
    ["tech.bun",         stableId("product", "carbon-cli"),   "CLI runs on Bun"],
    ["tech.bun",         stableId("product", "carbon-cloud"),  "Cloud runs on Bun"],
    ["tech.bun",         stableId("product", "carbon-website"),"Website builds with Bun"],
    ["tech.vite",        stableId("capability", "bundling"),   "Bundling uses Vite"],
    ["tech.babel",       stableId("capability", "bundling"),   "Bundling uses Babel transforms"],
    ["tech.react",       stableId("product", "carbon-website"),"Website uses React"],
    ["tech.docker",      stableId("product", "carbon-cloud"),  "Cloud runs in Docker"],
    ["tech.postgres",    stableId("product", "carbon-cloud"),  "Cloud stores data in PostgreSQL"],
    ["tech.minio",       stableId("product", "carbon-cloud"),  "Cloud stores artifacts in MinIO"],
    ["tech.quickjs",     stableId("product", "carbon"),        "Runtime executes JS via QuickJS"],
    ["tech.flatbuffers", stableId("solution", "contracts"),    "Contracts use FlatBuffers IDL"],
    ["tech.rust",        stableId("product", "carbon"),        "Runtime is written in Rust"],
    ["tech.zig",         stableId("product", "carbon-ext"),    "Extension SDK uses Zig"],
  ];

  for (const [tech, target, label] of TECH_USES) {
    if (entityIds.has(tech) && entityIds.has(target)) {
      add(target, tech, "USES", {
        label,
        confidence: "confirmed",
        evidence:   [evidenceFromFile("README.md")],
      });
    }
  }

  // ── 8. Host boundary relationships ────────────────────────────────────────

  if (entityIds.has("boundary.host")) {
    add(stableId("product", "carbon"), "boundary.host", "IMPLEMENTS", {
      label:     "Rust side: registers 139 host functions",
      confidence: "confirmed",
      evidence:  [evidenceFromFile("solutions/contracts/runtime/registry/host-boundary.toml")],
    });
    add(stableId("solution", "interface"), "boundary.host", "USES", {
      label:     "JS side: calls host functions via __cm_*",
      confidence: "confirmed",
      evidence:  [evidenceFromFile("solutions/interface/stdlib/bindings")],
    });
    add(stableId("contract", "runtime"), "boundary.host", "VALIDATES", {
      label:     "host-boundary.toml is the registry for both sides",
      confidence: "confirmed",
    });
  }

  // ── 9. @carbon/* alias map → relationships ────────────────────────────────

  // The tsconfig paths map gives us definitive TypeScript module boundaries.
  // Map key aliases to capability/infrastructure/contract IDs.
  const ALIAS_TO_ENTITY: Record<string, string> = {
    "@carbon/bundling":     stableId("capability", "bundling"),
    "@carbon/scaffolding":  stableId("capability", "scaffolding"),
    "@carbon/packaging":    stableId("capability", "packaging"),
    "@carbon/publishing":   stableId("capability", "publishing"),
    "@carbon/signing":      stableId("capability", "signing"),
    "@carbon/updating":     stableId("capability", "updating"),
    "@carbon/registry":     stableId("capability", "registry"),
    "@carbon/lifecycle":    stableId("capability", "lifecycle"),
    "@carbon/billing":      stableId("capability", "billing"),
    "@carbon/orchestration":stableId("capability", "orchestration"),
    "@carbon/worker":       stableId("capability", "worker"),
    "@carbon/identity":     stableId("capability", "identity"),
    "@carbon/logging":      stableId("solution", "logging"),
    "@carbon/process":      stableId("solution", "process"),
    "@carbon/workspace":    stableId("solution", "workspace"),
    "@carbon/cli":          stableId("solution", "cli"),
    "@carbon/contracts/app":    stableId("contract", "app"),
    "@carbon/contracts/plugin": stableId("contract", "plugin"),
    "@carbon/contracts/security": stableId("contract", "security"),
    "@carbon/contracts/update":   stableId("contract", "update"),
    "@carbon/contracts/distribution": stableId("contract", "distribution"),
    "@carbon/contracts/toolchain":    stableId("contract", "toolchain"),
    "@carbon/mini-react":   stableId("solution", "interface"),
    "@carbon/mini-solid":   stableId("solution", "interface"),
  };

  // Walk all TypeScript extractions and find @carbon/* imports
  for (const extraction of raw.extractions) {
    if (extraction.language !== "typescript") continue;

    const fileEntity = deriveFileEntityId(extraction.file);
    if (!fileEntity) continue;

    for (const dep of extraction.dependencies) {
      if (!dep.to.startsWith("@carbon/")) continue;

      const targetId = ALIAS_TO_ENTITY[dep.to];
      if (!targetId || !entityIds.has(targetId)) continue;
      if (!entityIds.has(fileEntity)) continue;

      // Only add if not already present
      const alreadyExists = relationships.some(
        r => r.from === fileEntity && r.to === targetId && r.relationship === "DEPENDS_ON"
      );
      if (!alreadyExists) {
        add(fileEntity, targetId, "DEPENDS_ON", {
          label:     `imports ${dep.to}`,
          confidence: "confirmed",
          evidence:  [dep.evidence],
        });
      }
    }
  }

  // ── 10. Contract VALIDATES relationships ──────────────────────────────────

  // The conformance test validates app contract across 3 implementations
  add(stableId("contract", "app"), stableId("product", "carbon"),      "VALIDATES", {
    label:     "Rust config.rs must match schema",
    confidence: "confirmed",
    evidence:  [evidenceFromFile(".github/CONTRIBUTING.md")],
  });
  add(stableId("contract", "app"), stableId("product", "carbon-cli"),  "VALIDATES", {
    label:     "TypeScript CarbonManifest.ts must match schema",
    confidence: "confirmed",
    evidence:  [evidenceFromFile(".github/CONTRIBUTING.md")],
  });

  // ── 11. Deduplication ─────────────────────────────────────────────────────

  // Remove exact duplicates (same from, to, relationship)
  const seen = new Set<string>();
  return relationships.filter(r => {
    const key = `${r.from}→${r.to}:${r.relationship}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a file path to the most specific entity that owns it */
function deriveFileEntityId(filePath: string): string | null {
  const parts = filePath.split("/");

  if (parts[0] === "products" && parts[1]) {
    return stableId("product", parts[1]);
  }
  if (parts[0] === "solutions") {
    const tier = parts[1];
    const module = parts[2];
    if (tier && module) return stableId(tier, module);
    if (tier) return stableId("solution", tier);
  }
  if (parts[0] === ".tools") return "build.bazel-workspace";
  if (parts[0] === ".github") return "system.carbon-native";
  return null;
}
