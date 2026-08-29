# Carbon Native — Semantic Assessment Pipeline

Analyzes the entire repository and produces a **semantic model of how the system works**, together with a highly interactive web explorer. The goal is that almost every reasonable question about system behavior is answerable from the generated model — without reading source code.

---

## Quick start

```powershell
# From the repo root — install the assessment tool's dependencies once
bun install --cwd .tools/automation/assessment
bun install --cwd .tools/automation/assessment/web

# Build the explorer UI (once, or after UI changes)
cd .tools/automation/assessment/web && bun run build && cd ..

# Run the full analysis pipeline (~2–3 seconds)
bun run index.ts

# Start the interactive explorer
bun run index.ts --serve
# Then open http://localhost:4040
```

---

## What it produces

```
.architecture/
├── raw/
│   ├── files.json          Every scanned file with hash, language, tier
│   ├── manifest.json       Hashes for incremental re-runs
│   ├── repository.json     Aggregate stats, Cargo/npm manifests, CI summary
│   ├── logic.json          All extracted conditionals, per file
│   ├── dependencies.json   All @carbon/* imports and external calls
│   ├── ci.json             Full CI workflow extraction
│   └── builds.json         Bazel targets, Cargo manifests, npm manifests
│
├── semantic/
│   └── architecture.json   The final semantic model (entities + relationships
│                           + rules + flows + contradictions + potential issues)
│
├── human/
│   └── overrides.json      Your review edits — never overwritten by a re-run
│
└── reports/
    ├── coverage.json        Machine-readable coverage stats
    └── coverage.txt         Human-readable summary
```

---

## Pipeline stages

The pipeline runs as six independent, sequentially composable stages:

| Stage | What it does |
|---|---|
| `scan` | Walks the repo, classifies files by language and tier, computes hashes |
| `extract` | Runs language-specific extractors over each file |
| `interpret` | Transforms raw evidence into semantic entities, rules, and flows |
| `resolve` | Builds the relationship graph between entities |
| `model` | Merges everything + human overrides into `architecture.json` |
| `report` | Generates `coverage.json` and `coverage.txt` |

Run a single stage:

```powershell
bun run index.ts --stage scan
bun run index.ts --stage extract
# etc.
```

Run incrementally (only re-extracts changed files):

```powershell
bun run index.ts --incremental
```

---

## Interactive explorer

Seven views:

| View | Purpose |
|---|---|
| **Explorer** | Browse all entities with type/tier/confidence filters. Click any entity to see its full detail panel: description, relationships, rules, flows, config, evidence. |
| **Logic** | Browse all 4,000+ semantic rules and checks. Grouped by context or kind. Each rule shows the full IF → action → outcome logic tree. |
| **Flows** | Step-by-step flow diagrams for all identified processes (app startup, CI pipeline, runtime build, CLI invocation, etc.). Click any step for detail. |
| **Search** | Full-text semantic search across entities, rules, and flows. Quick-search buttons for common questions. Trace-path result display. |
| **Graph** | Force-directed SVG graph with zoom/pan/drag. Focus mode shows a single entity's neighborhood. Trace paths highlighted in green. |
| **Review** | Review queue for potential issues, contradictions, inferences, and unknowns. Accept / Reject / Edit / Ignore each item. Saved to `overrides.json`. |
| **Coverage** | File coverage stats by language, entity counts, confidence distribution, analysis gaps, contradictions, and potential issues. |

---

## Human review

All model edits survive a re-run. When you accept, reject, or edit an item in the Review view, the change is written to `.architecture/human/overrides.json`. Re-running the pipeline re-applies those overrides on top of the freshly generated model.

To add entirely new entities, rules, or flows that the analyzer missed, add them to the `additions` arrays in `overrides.json`.

---

## Configuration

Edit `.tools/automation/assessment/assess.config.json` to:

- Change which directories are ignored (`ignore.directories`)
- Adjust the max file size for extraction (`analysis.maxFileSizeBytes`)
- Enable/disable individual extractors (`extractors.*`)
- Change the output directory (`output.dir`)
- Change the explorer port (`web.port`)

---

## Extending the pipeline

Each stage is independently importable. Add a new extractor in `extractors/` and register it in `stages/pipeline.ts`. The type system lives in `stages/types.ts` and is shared between the pipeline and the explorer.

```
.tools/automation/assessment/
├── index.ts                 CLI entry point
├── assess.config.json       Configuration
├── stages/
│   ├── types.ts             All type definitions (shared with web)
│   ├── config.ts            Config loader
│   ├── scan.ts              Stage 1 — file walker
│   ├── interpret.ts         Stage 3 — semantic interpreter
│   ├── resolve.ts           Stage 4 — relationship resolver
│   ├── model.ts             Stage 5 — model writer
│   ├── report.ts            Stage 6 — coverage reporter
│   └── pipeline.ts          Orchestrator + static file server
├── extractors/
│   ├── typescript.ts        Babel AST extractor
│   ├── rust.ts              Regex-based Rust extractor
│   └── ci-build.ts          CI, Cargo, npm, Bazel, Docker, shell, .fbs, JSON
└── web/                     React + Vite explorer app
    └── src/
        ├── lib/             types.ts · api.ts · store.ts
        ├── components/      ui/ · explorer/ · views/
        └── App.tsx
```

---

## What the numbers mean

After a full run on Carbon Native V2:

- **1,054 files** scanned in ~540ms
- **703 files** extracted (96% coverage)
- **4,483 semantic rules** — every meaningful conditional in the codebase
- **47 semantic entities** — products, solutions, contracts, capabilities, technologies, build systems, CI pipelines, feature flags, external integrations, the host boundary
- **48 relationships** — CONTAINS, DEPENDS_ON, BUILDS, IMPLEMENTS, VALIDATES, USES, DEPLOYS, and more
- **7 flows** — Runtime Build, CLI Invocation, App Startup, CI (4 workflows)
- **48 potential issues** flagged for review
- **Full run: ~2.4 seconds**
