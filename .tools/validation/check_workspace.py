#!/usr/bin/env python3
"""
Carbon Native V2 - Workspace Structure & Boundary Validator
Ensures directory invariants, BUILD file presence, and module boundary hygiene.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

def validate_workspace(root: Path) -> bool:
    print(f"[*] Validating Carbon Native V2 workspace at: {root.resolve()}")
    passed = True

    # shared/ is the contract tier, split by KIND of contract — each has a
    # different toolchain and a different set of consumers.
    # Every contract is a directory following one pattern — see
    # solutions/shared/contracts/README.md.
    CONTRACTS = [
        "abi", "core", "api", "events", "ipc",
        "manifest", "permissions", "security", "versioning", "project",
    ]
    # solutions/ has five categories, ordered by dependency direction.
    # See solutions/README.md.
    CONTRACT_SUBJECTS = [
        "core", "app", "plugin", "host", "security", "versioning", "update",
        "distribution", "toolchain", "runtime",
    ]
    # capabilities/ has a category layer now: <category>/<capability>, every
    # category and every capability name a single word — no exceptions, no
    # ungrouped leftovers at capabilities/ root (math included: it lives
    # under rendering/, its only real consumer, rather than sitting alone).
    # Kept current with what's actually on disk below, not hand-maintained
    # against drift — this list previously named only 13 of the (then-)21
    # folders and nothing caught it, since it feeds an existence check, not
    # an exhaustiveness one. See CAPABILITIES_ROOT usage below.
    CAPABILITIES = [
        # cloud/
        "cloud/billing", "cloud/orchestration", "cloud/worker", "cloud/identity",
        # distribution/
        "distribution/packaging", "distribution/publishing",
        "distribution/signing", "distribution/updating",
        # rendering/ (Rust, migrated from V1's carbon/ — see products/carbon/MIGRATION.md)
        "rendering/audio", "rendering/gpu", "rendering/imaging", "rendering/math",
        "rendering/layout", "rendering/painting", "rendering/snapshot", "rendering/text",
        # plugin/
        "plugin/registry", "plugin/lifecycle", "plugin/sdk",
        # tooling/
        "tooling/bundling", "tooling/scaffolding",
    ]
    INFRASTRUCTURE = ["logging", "process", "workspace"]

    contract_dirs = ["solutions/contracts/" + s for s in CONTRACT_SUBJECTS]

    # Products follow one template — see products/README.md.
    # Every product, and the layer every product has.
    #
    # A product ALWAYS has presentation — the surfaces something reaches it
    # through. carbon-cli's is commands, because a developer types them;
    # carbon's is the __cm_* host functions, the event loop and the startup
    # trace. Beyond that a product has whatever it needs: carbon has a
    # composition layer because standing a runtime up for a particular app is
    # most of what it does.
    product_dirs = [
        # carbon-ext: the extension-point registry tool. A product rather than
        # tooling because it owns a runtime CONTRACT — see its main.ts.
        "products/carbon-ext",
        "products/carbon-ext/composition",
        "products/carbon-ext/presentation",
        "products/carbon-ext/tests",
        "products/carbon-cli",
        "products/carbon-cli/composition",
        "products/carbon-cli/presentation",
        "products/carbon-cli/presentation/commands",
        "products/carbon-cli/tests",
        "products/carbon",
        "products/carbon/composition",
        "products/carbon/presentation",
        "products/carbon/tests",
    ]

    solution_dirs = (
        ["solutions/capabilities/" + c for c in CAPABILITIES]
        + ["solutions/infrastructure/" + i for i in INFRASTRUCTURE]
        + [
            "solutions/interface/cli",
            "solutions/integrations/bundler/vite",
            "solutions/integrations/transpiler/babel",
        ]
    )

    required_dirs = [
        # A tier, not a target: labs/ must exist even when empty, so
        # experiments always have somewhere to go that is not products/ or
        # solutions/. Its contents are disposable; the directory is not.
        "labs",
        "products",
        "solutions",
        "solutions/contracts",
        "solutions/capabilities",
        "solutions/infrastructure",
        "solutions/integrations",
        "solutions/interface",
        ".config",
        ".tools",
    ] + contract_dirs + product_dirs + solution_dirs

    for d in required_dirs:
        p = root / d
        if not p.is_dir():
            print(f"[FAIL] Missing required directory: {d}")
            passed = False
        else:
            print(f"[OK] Directory verified: {d}")

    # Root hygiene is checked against README.md, not against a list here.
    #
    # This used to be an allow-list of ~20 names with a paragraph explaining the
    # rule. It worked, and it was a second declaration of something README.md
    # section 3 already stated — so the two could disagree, and the document
    # was the copy that went stale. check_readme_layout.py now reads the
    # README's own layout blocks and checks the root, .config/ and .tools/ in
    # both directions: nothing declared may be missing, and nothing present may
    # be undeclared. It is delegated to at the bottom of this file.


    required_files = [
        # Bazel — the only source files permitted at the workspace root.
        "MODULE.bazel",
        "BUILD.bazel",
        ".bazelrc",
        ".bazelversion",
        # No LICENSE. It was required here because every Cargo.toml and
        # package.json declared `license = "Apache-2.0"`, so its absence meant
        # the repository asserted a license it did not ship. Those claims have
        # been removed from every manifest instead, so there is no assertion
        # left for a notice to back.
        # Governance. GitHub reads CONTRIBUTING and SECURITY from .github/ as
        # readily as from the root, and the root is Bazel's.
        ".github/CONTRIBUTING.md",
        ".github/SECURITY.md",
        # Central configuration, including the relocated npm manifest and the
        # path aliases that replaced bun workspaces.
        ".config/_identity.json",
        ".config/build.json",
        ".config/package.json",
        ".config/tsconfig.base.json",
        "labs/README.md",
        # Contracts.
        "solutions/contracts/plugin/abi/carbon_abi.h",
        # The extension-point registry, and the three renderings generated
        # from it. Listed because check_extension_points.py compares them
        # against the Zig and would report "nothing to compare" rather than a
        # failure if one were simply deleted.
        "solutions/contracts/plugin/registry/extension-points.zig",
        "solutions/contracts/plugin/abi/carbon_extension_points.h",
        "solutions/contracts/plugin/rust/generated.rs",
        "solutions/contracts/plugin/types/ExtensionPoints.ts",
        # carbon-ext is the plugin SDK, so what makes it a product is its
        # surface and its wiring, not an entrypoint — see the note on the
        # product template below.
        "products/carbon-ext/composition/build.zig",
        "products/carbon-ext/presentation/include/carbon_plugin.h",
        "solutions/capabilities/plugin/registry/index.ts",
        "solutions/README.md",
        "solutions/contracts/defs.bzl",
        "solutions/contracts/BUILD.bazel",
        "solutions/contracts/core/schema/core.fbs",
        "solutions/contracts/app/schema/carbon.schema.json",
        # The Bun toolchain that makes Bazel the entrypoint for the TS tier.
        ".tools/orchestration/bazel/bun/BUILD.bazel",
        ".tools/orchestration/bazel/bun/defs.bzl",
        ".tools/orchestration/bazel/bun/extensions.bzl",
        ".tools/orchestration/bazel/bun/repositories.bzl",
        ".tools/orchestration/bazel/bun/toolchain.bzl",
        ".tools/automation/bootstrap/link-node-modules.ps1",
        ".tools/automation/bootstrap/link-node-modules.sh",
        # The CLI.
        "products/carbon-cli/BUILD.bazel",
        "products/carbon-cli/package.json",
        "products/carbon-cli/README.md",
        "products/carbon-cli/tsconfig.json",
        "products/carbon-cli/main.ts",
        "products/carbon-cli/composition/registry.ts",
        ".tools/automation/build/cached-build.ts",
        ".tools/automation/release/publish.ts",
        # Shared TypeScript.
        "solutions/tsconfig.json",
        ".tools/environments/docker/Dockerfile",
        ".tools/environments/docker/docker-compose.yml",
        ".tools/environments/devcontainer/devcontainer.json",
        "solutions/capabilities/distribution/signing/index.ts",
        "solutions/capabilities/distribution/updating/index.ts",
        "solutions/infrastructure/workspace/index.ts",
        "solutions/interface/cli/index.ts",
        "products/README.md",
    ]

    for f in required_files:
        p = root / f
        if not p.is_file():
            print(f"[FAIL] Missing required file: {f}")
            passed = False
        else:
            print(f"[OK] File verified: {f}")

    # Dependency direction. domain/ is the centre of the clean core: it may not
    # import from application/ or infrastructure/, and it may not reach for a
    # library that ties it to a runtime. Checking the folders exist proves
    # nothing; this checks the rule they exist to express.
    #
    # Only import lines are examined, so prose in a comment naming a layer does
    # not trip it.
    FORBIDDEN_IN_DOMAIN = ("/application/", "/infrastructure/", "smol-toml")
    domain_violations = 0
    # capabilities/ has a category layer now — math sits directly under it
    # (*/domain), everything else one level deeper (*/*/domain).
    domain_dirs = sorted(root.glob("solutions/capabilities/*/domain")) + sorted(
        root.glob("solutions/capabilities/*/*/domain")
    )
    for domain_dir in domain_dirs:
        for source in sorted(domain_dir.rglob("*.ts")):
            if source.name.endswith(".test.ts"):
                continue
            rel = source.relative_to(root).as_posix()
            for line in source.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not (stripped.startswith("import ") or stripped.startswith("export ")):
                    continue
                if " from " not in stripped and not stripped.startswith("import \""):
                    continue
                for forbidden in FORBIDDEN_IN_DOMAIN:
                    if forbidden in stripped:
                        print(f"[FAIL] domain imports outward: {rel} -> {forbidden}")
                        domain_violations += 1
                        passed = False

    # The same rule for Rust, which the TypeScript glob above does not see.
    #
    # Rust makes this harder than TypeScript in one specific way: the crates use
    # `#[path = "<layer>/<file>.rs"]` so module names survive the restructure,
    # which means a module's NAME no longer says which layer it lives in.
    # `use crate::decoder::DecodedImage` looks identical whether decoder.rs sits
    # in domain/ or infrastructure/.
    #
    # So the layer map is read out of the #[path] attributes themselves, and
    # `use crate::<name>` is resolved through it. Without this, adding a Rust
    # capability silently added zero coverage — the check kept printing OK while
    # inspecting nothing, which is how the imaging and audio violations got in.
    path_attr = re.compile(r'#\[path\s*=\s*"([^"]+)"\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;')
    use_crate = re.compile(r'^\s*use\s+crate::(\w+)')

    lib_rs_files = sorted(root.glob("solutions/capabilities/*/lib.rs")) + sorted(
        root.glob("solutions/capabilities/*/*/lib.rs")
    )
    for lib in lib_rs_files:
        capability = lib.parent
        # module name -> the directory its file actually lives in
        layer_of = {}
        for rel_path, mod_name in path_attr.findall(lib.read_text(encoding="utf-8")):
            layer_of[mod_name] = rel_path.split("/")[0] if "/" in rel_path else ""

        domain_dir = capability / "domain"
        if not domain_dir.is_dir():
            continue

        for source in sorted(domain_dir.rglob("*.rs")):
            rel = source.relative_to(root).as_posix()
            for line in source.read_text(encoding="utf-8").splitlines():
                match = use_crate.match(line)
                if not match:
                    continue
                target_layer = layer_of.get(match.group(1))
                if target_layer in ("application", "infrastructure"):
                    print(
                        f"[FAIL] domain imports outward: {rel} -> "
                        f"crate::{match.group(1)} (in {target_layer}/)"
                    )
                    domain_violations += 1
                    passed = False

    # ── Tier dependency direction ───────────────────────────────────────────
    #
    # solutions/ is a DAG, not a line. The README used to claim the five tiers
    # were "ordered by dependency direction — each may depend on the ones above
    # it, never the ones below", and measuring it found 22 breaches of that rule
    # in the tree, every one of them correct design: a capability using a
    # ProcessRunner port, or bundling driving Vite. The rule was wrong, not the
    # code.
    #
    # What is actually true:
    #
    #   contracts/       depends on NOTHING. It is the agreement layer; a
    #                    contract that imports an implementation is not one.
    #   infrastructure/  may use contracts. Not capabilities — a technical
    #                    service that knows what business calls it is not a
    #                    service.
    #   integrations/    same.
    #   capabilities/    may use contracts, infrastructure, integrations.
    #   interface/       may use anything, and NOTHING may use it. It is the
    #                    driving edge — the same argument that keeps the CLI in
    #                    products/.
    ALLOWED = {
        "contracts": set(),
        "infrastructure": {"contracts"},
        "integrations": {"contracts"},
        "capabilities": {"contracts", "infrastructure", "integrations"},
        "interface": {"contracts", "infrastructure", "integrations", "capabilities"},
    }

    # Which tier an @carbon/* specifier resolves to, read from the tsconfig
    # paths so it cannot drift from the actual wiring.
    tier_of_alias = {}
    base = root / ".config" / "tsconfig.base.json"
    if base.is_file():
        text = re.sub(r"^\s*//.*$", "", base.read_text(encoding="utf-8"), flags=re.M)
        for alias, targets in json.loads(text)["compilerOptions"]["paths"].items():
            m = re.search(r"solutions/(\w+)/", targets[0])
            if m and m.group(1) in ALLOWED:
                tier_of_alias[alias.rstrip("/*").rstrip("/")] = m.group(1)

    def resolve(spec):
        for key in sorted(tier_of_alias, key=len, reverse=True):
            if spec == key or spec.startswith(key + "/"):
                return tier_of_alias[key]
        return None

    # Only real import/export statements.
    #
    # Template literals are stripped FIRST. Both scaffolding's App.tsx template
    # and babel's @CarbonApp epilogue contain the line
    #
    #     import { mount } from "@carbon/mini-solid";
    #
    # inside a backtick string — generated code for somebody else's project, not
    # a dependency of the file emitting it. A line-anchored regex cannot tell
    # the difference, and reading them as real produced three confident false
    # failures the first time this check ran.
    TEMPLATE_LITERAL = re.compile(r"`(?:[^`\\]|\\.)*`", re.S)
    STATEMENT = re.compile(
        r'^\s*(?:import|export)\b[^;\n]*?\bfrom\s+"(@carbon/[^"]+)"', re.M
    )

    tier_violations = 0
    for source in sorted((root / "solutions").rglob("*.ts")):
        rel = source.relative_to(root).as_posix()
        if "node_modules" in rel or "/tests/" in rel:
            continue
        parts = source.relative_to(root / "solutions").parts
        if not parts or parts[0] not in ALLOWED:
            continue
        src_tier = parts[0]
        code = TEMPLATE_LITERAL.sub("``", source.read_text(encoding="utf-8"))
        for spec in STATEMENT.findall(code):
            dst_tier = resolve(spec)
            if dst_tier and dst_tier != src_tier and dst_tier not in ALLOWED[src_tier]:
                print(f"[FAIL] {src_tier} may not depend on {dst_tier}: {rel} -> {spec}")
                tier_violations += 1
                passed = False

    if tier_violations == 0:
        print("[OK] Tier direction: contracts depend on nothing, nothing depends on interface")

    if domain_violations == 0:
        print("[OK] Dependency direction: domain/ imports nothing outward")

    # The product template — see products/README.md. Applied to every product
    # that has code (a package.json), so a new one conforms without anybody
    # remembering to add it here.
    #
    # The rule with teeth is the last one: a product composes and presents. A
    # domain/ or application/ layer inside products/ means business logic has
    # leaked out of solutions/, which is the drift this whole layout exists to
    # prevent.
    # ── Executable products ─────────────────────────────────────────────────
    #
    # Applied to every product that has a package.json, which is what makes it
    # a Bun program. carbon-ext deliberately has none: it is the plugin SDK, a
    # LIBRARY deliverable — a C header, Zig modules and scaffold templates —
    # and a library has no entrypoint to require. It is still a product,
    # because a product is a shipping deliverable and that is exactly what an
    # SDK is, and it still has composition/ and presentation/, which the
    # required-directory list above checks.
    #
    # The template used to demand a main.ts of everything, and carbon-ext was
    # briefly given one — a second CLI, with its own dispatcher and command
    # registry, for commands that belonged in carbon-cli. The rule was part of
    # what made that look correct.
    template_violations = 0
    for manifest in sorted(root.glob("products/*/package.json")):
        product = manifest.parent
        name = product.name

        # carbon-vscode is a VS Code extension: package.json IS the manifest
        # VS Code loads, so it can't be dropped the way carbon-ext dropped its
        # to skip this loop. It activates through `contributes`, not a script
        # this repo runs — there is no main.ts, and nothing to compose or
        # test beyond what `vsce package` already checks. The signal is
        # `engines.vscode` itself, not the product's name, so any future
        # extension gets the same exemption without editing this file again.
        try:
            declares_vscode = "vscode" in json.loads(manifest.read_text(encoding="utf-8")).get("engines", {})
        except (json.JSONDecodeError, OSError):
            declares_vscode = False
        if declares_vscode:
            continue

        for required in ("main.ts", "composition", "presentation", "tests"):
            if not (product / required).exists():
                print(f"[FAIL] product {name} is missing {required}/ (products/README.md)")
                template_violations += 1
                passed = False

        for forbidden in ("domain", "application", "src"):
            if (product / forbidden).is_dir():
                reason = (
                    "products compose and present; business logic belongs in solutions/"
                    if forbidden != "src"
                    else "layers sit at the product root, not under src/"
                )
                print(f"[FAIL] product {name} has {forbidden}/ — {reason}")
                template_violations += 1
                passed = False

    # The contract pattern: every contract directory carries a definition, a
    # BUILD that calls into defs.bzl, and a README stating its compatibility
    # policy. See solutions/shared/contracts/README.md.
    contract_violations = 0
    for contract in sorted((root / "solutions/contracts").iterdir()):
        if not contract.is_dir():
            continue
        for required in ("BUILD.bazel", "README.md"):
            if not (contract / required).is_file():
                print(f"[FAIL] contract {contract.name} is missing {required}")
                contract_violations += 1
                passed = False
        definitions = list(contract.glob("schema/*.fbs")) + list(contract.glob("schema/*.json")) +             list(contract.glob("abi/*.h")) + list(contract.glob("types/*.ts")) + list(contract.glob("registry/*.toml"))
        if not definitions:
            print(f"[FAIL] contract {contract.name} has no definition file")
            contract_violations += 1
            passed = False

    if contract_violations == 0:
        print("[OK] Contract pattern: definition + BUILD + README in every contract")

    if template_violations == 0:
        print("[OK] Product template: every product composes and presents, nothing more")

    # -- Toolchain versions: .config/dependencies.json vs MODULE.bazel -------
    #
    # These had drifted: dependencies.json recorded flatbuffers 23.5.26, a
    # version that has never existed on the registry, while MODULE.bazel
    # carried 24.3.25 because that is what it took to resolve. Nothing
    # compared them, so the file that reads like the source of truth held a
    # value that would fail the moment anything used it.
    #
    # The agreement is contracts/toolchain. This is where it is enforced.
    version_violations = 0
    deps_file = root / ".config" / "dependencies.json"
    module_file = root / "MODULE.bazel"

    if deps_file.is_file() and module_file.is_file():
        declared = json.loads(deps_file.read_text(encoding="utf-8")).get("libraries", {})
        module_text = module_file.read_text(encoding="utf-8")

        # bazel_dep(name = "x", version = "1.2.3", ...) - name then version,
        # with anything permitted after.
        pinned = dict(
            re.findall(
                r'bazel_dep\(\s*name\s*=\s*"([^"]+)"\s*,\s*version\s*=\s*"([^"]+)"',
                module_text,
            )
        )

        for name, version in sorted(declared.items()):
            if name not in pinned:
                print(
                    f"[FAIL] dependencies.json pins {name} {version}, "
                    f"but MODULE.bazel has no bazel_dep for it"
                )
                version_violations += 1
                passed = False
            elif pinned[name] != version:
                print(
                    f"[FAIL] {name}: dependencies.json says {version}, "
                    f"MODULE.bazel says {pinned[name]}"
                )
                version_violations += 1
                passed = False

    if version_violations == 0:
        print("[OK] Toolchain versions: dependencies.json agrees with MODULE.bazel")

    # ── The JS <-> Rust boundary ────────────────────────────────────────────
    #
    # Delegated to check_host_boundary.py, which owns the comparison. Run from
    # here so `check_workspace.py` stays the single command: a check nobody
    # remembers to run is not a check.
    #
    # Until the host layer migrates (phase 4), there is no boundary-touching
    # Rust in this workspace and the checker reports SKIP rather than a vacuous
    # OK. The real surface still lives in V1.
    boundary = Path(__file__).resolve().parent / "check_host_boundary.py"
    if boundary.is_file():
        result = subprocess.run(
            [sys.executable, str(boundary)],
            capture_output=True,
            text=True,
        )
        for line in result.stdout.strip().splitlines():
            print(line)
        if result.returncode != 0:
            passed = False

    # ── The declared layout ─────────────────────────────────────────────────
    #
    # Delegated to check_readme_layout.py. README.md section 3 is the only
    # statement of what the root, .config/ and .tools/ hold, and for most of
    # the migration it described a tree that no longer existed while four
    # undeclared directories accumulated inside the two it did describe.
    readme_layout = Path(__file__).resolve().parent / "check_readme_layout.py"
    if readme_layout.is_file():
        result = subprocess.run(
            [sys.executable, str(readme_layout)],
            capture_output=True,
            text=True,
        )
        for line in result.stdout.strip().splitlines():
            print(line)
        if result.returncode != 0:
            passed = False

    # ── One build output directory, declared three times ────────────────────
    #
    # `cargo build` reads .cargo/config.toml. The Bazel rules set
    # CARGO_TARGET_DIR themselves. `carbon run` looks for the built binary
    # through TARGET_DIR in solutions/infrastructure/workspace. All three must
    # name the same directory, and nothing makes them: they are three files in
    # three languages, and the symptom of disagreement is a binary that builds
    # successfully and cannot be found.
    #
    # They have disagreed twice. TARGET_DIR's own comment records the first.
    target_dir_sources = {
        ".cargo/config.toml": r'target-dir\s*=\s*"([^"]+)"',
        ".tools/orchestration/bazel/cargo/defs.bzl": r'"CARGO_TARGET_DIR":\s*"([^"]+)"',
    }
    declared_targets = {}
    for rel, pattern in target_dir_sources.items():
        path = root / rel
        if not path.is_file():
            print(f"[FAIL] missing {rel} — it declares where cargo writes")
            passed = False
            continue
        # Comments stripped first. The .cargo config QUOTES the V1 value it
        # replaced, in the comment explaining why this file exists, and a bare
        # search found that before the real assignment — a checker that reads
        # documentation as configuration.
        text = re.sub(r"^\s*#.*$", "", path.read_text(encoding="utf-8"), flags=re.M)
        match = re.search(pattern, text)
        if not match:
            print(f"[FAIL] {rel} no longer declares a cargo target directory")
            passed = False
            continue
        declared_targets[rel] = match.group(1)

    # The TypeScript one is composed from CARGO_WORKSPACE_DIR rather than
    # written out, so it is matched on the segment and recomposed.
    layout = root / "solutions/infrastructure/workspace/adapters/WorkspaceLayout.ts"
    if layout.is_file():
        text = layout.read_text(encoding="utf-8")
        match = re.search(r'export const TARGET_DIR = join\(CARGO_WORKSPACE_DIR, "([^"]+)"\);', text)
        if match:
            declared_targets["WorkspaceLayout.ts"] = (
                f".tools/orchestration/bazel/cargo/{match.group(1)}"
            )
        else:
            print("[FAIL] WorkspaceLayout no longer derives TARGET_DIR from CARGO_WORKSPACE_DIR")
            passed = False

    if len(set(declared_targets.values())) > 1:
        print("[FAIL] cargo's target directory is declared inconsistently:")
        for rel, value in sorted(declared_targets.items()):
            print(f"         {value}   ({rel})")
        print("       A binary built by one and looked for by another is not found.")
        passed = False
    elif declared_targets:
        only = next(iter(declared_targets.values()))
        print(f"[OK] Build output: {len(declared_targets)} declarations, all {only}")

    # ── The extension-point registry ────────────────────────────────────────
    #
    # Delegated to check_extension_points.py, which delegates in turn to
    # `carbon ext check`. Three languages hold a rendering of one Zig
    # declaration; nothing in a compiler notices when one stops matching,
    # because each is internally consistent. Same shape of problem as the
    # JS<->Rust boundary above, same answer.
    extension_points = Path(__file__).resolve().parent / "check_extension_points.py"
    if extension_points.is_file():
        result = subprocess.run(
            [sys.executable, str(extension_points)],
            capture_output=True,
            text=True,
        )
        for line in result.stdout.strip().splitlines():
            print(line)
        if result.returncode != 0:
            passed = False

    # ── TypeScript ──────────────────────────────────────────────────────────
    #
    # Delegated to check_typescript.py, which discovers every tsconfig rather
    # than checking one. There are seven projects now: five packages need
    # compiler options (lib DOM, --jsx) the rest of the tree must not have, so
    # a single `tsc -p solutions` would report zero errors while covering half
    # the tree — which is exactly how a stale `include` hid twice before.
    typescript = Path(__file__).resolve().parent / "check_typescript.py"
    if typescript.is_file():
        result = subprocess.run(
            [sys.executable, str(typescript), "--quiet"],
            capture_output=True,
            text=True,
        )
        for line in result.stdout.strip().splitlines():
            print(line)
        if result.returncode != 0:
            passed = False

    # ── Internal shape ──────────────────────────────────────────────────────
    #
    # solutions/README.md used to say "every capability follows the same
    # internal shape". Half of them did not, and each exception was documented
    # and correct — text is one cohesive struct, snapshot is entirely FFI, audio
    # cannot separate a domain from its shared graph.
    #
    # The claim was wrong because ONE shape was being asserted over THREE kinds
    # of thing. Measuring which product consumes each of them separates them
    # cleanly:
    #
    #   consumed by the CLI    -> use-case shaped   6 of 6
    #   consumed by the runtime-> flat/algorithmic  7 of 9
    #
    # So the rule is per KIND, declared here, rather than one rule that half the
    # tree has to opt out of. A capability declares its kind in package.json or
    # Cargo.toml via `carbon.kind`; absent, it is inferred from whether it has
    # an application/ directory.
    #
    #   service    domain/ + application/{ports,usecases}/ + infrastructure/
    #              The toolchain doing something for a developer. Has use cases
    #              because a developer invokes them.
    #   engine     no application/ — engines have algorithms, not use cases.
    #              A computational subsystem the runtime composes.
    #   library    flat. Pure computation, no carbon knowledge, replaceable by
    #              an off-the-shelf package.
    #
    # What is checked is only what is load-bearing: a service must have the
    # layers its shape promises, and an engine must NOT grow use cases (which is
    # how an engine turns into a service by accident).
    # A capability is a directory carrying its own package.json/Cargo.toml.
    # Anything else directly under capabilities/ is a category (cloud/,
    # distribution/, plugin/, rendering/, tooling/) — has no manifest of its
    # own, so its children are the real capabilities, one level deeper.
    def iter_capabilities():
        for entry in sorted((root / "solutions" / "capabilities").iterdir()):
            if not entry.is_dir():
                continue
            if (entry / "package.json").is_file() or (entry / "Cargo.toml").is_file():
                yield entry
                continue
            for child in sorted(entry.iterdir()):
                if child.is_dir():
                    yield child

    shape_violations = 0
    for capability in iter_capabilities():
        rel = capability.relative_to(root).as_posix()

        kind = None
        for manifest, key in ((capability / "package.json", '"kind"'),
                              (capability / "Cargo.toml", "kind")):
            if manifest.is_file():
                text = manifest.read_text(encoding="utf-8")
                m = re.search(r'carbon[.\-_]?kind["\s:=]+"?(\w+)"?', text)
                if m:
                    kind = m.group(1)
                    break
        if kind is None:
            kind = "service" if (capability / "application").is_dir() else "engine"

        if kind == "service":
            if not (capability / "application").is_dir():
                print(f"[FAIL] service {rel} has no application/ — that is what "
                      f"makes it a service")
                shape_violations += 1
                passed = False

            # A service needs a model, but not necessarily a LOCAL one.
            #
            # This rule started as "must have domain/", and three services
            # failed it: bundling, packaging and publishing. All three were
            # right and the rule was wrong — their model is a CONTRACT, shared
            # with whoever else speaks it. packaging models installer targets
            # via contracts/distribution; publishing models the release
            # manifest via contracts/update and contracts/security.
            #
            # That is the better outcome, not a loophole: a model two
            # capabilities share belongs in contracts, and duplicating it into
            # a local domain/ to satisfy a directory check is exactly the drift
            # contracts exist to stop. What is actually forbidden is a service
            # with no model anywhere.
            has_local = (capability / "domain").is_dir()
            has_contract = any(
                "@carbon/contracts" in f.read_text(encoding="utf-8", errors="replace")
                for f in capability.rglob("*.ts")
                if "/tests/" not in f.as_posix()
            )
            if not has_local and not has_contract:
                print(f"[FAIL] service {rel} has neither a domain/ nor a contract "
                      f"— where is its model?")
                shape_violations += 1
                passed = False
        elif kind == "engine":
            # The first version of this rule said an engine may not have an
            # application/ directory. `imaging` failed it, and `imaging` was
            # right: it is composed by the runtime, and it does have one genuine
            # use case — load an image, capability-checked first. Directory
            # presence was never the invariant.
            #
            # What actually matters is direction. An engine that calls a service
            # has inverted the system: the render path would depend on the
            # toolchain, so painting a frame could not happen without the thing
            # that publishes releases.
            for source in capability.rglob("*.rs"):
                text = source.read_text(encoding="utf-8", errors="replace")
                for service in ("carbon_updater", "carbon_plugin_host"):
                    if re.search(rf"{service}::", text):
                        print(f"[FAIL] engine {rel} depends on a service: {service}")
                        shape_violations += 1
                        passed = False
                        break

        elif kind == "library":
            # A library is defined by replaceability: it could be swapped for an
            # off-the-shelf package. That only holds while it knows nothing
            # about carbon.
            manifests = [capability / "Cargo.toml", capability / "rust" / "Cargo.toml",
                         capability / "package.json"]
            for manifest in manifests:
                if not manifest.is_file():
                    continue
                body = manifest.read_text(encoding="utf-8")
                deps = re.findall(r'^(carbon-[\w-]+)\s*=', body, re.M)
                deps += re.findall(r'"(@carbon/[\w/-]+)":', body)
                if deps:
                    print(f"[FAIL] library {rel} depends on carbon: {sorted(set(deps))} "
                          f"— a library that knows about carbon is a capability")
                    shape_violations += 1
                    passed = False

    if shape_violations == 0:
        print("[OK] Internal shape: services have a model, engines and libraries "
              "depend downward only")

    # ── Package layout ──────────────────────────────────────────────────────
    #
    # The rules above are all about capabilities/, because for a long time that
    # was the only tier this repository described from the inside. It showed.
    # The other three had grown packages that were a pile of files in a
    # directory: interface/renderer/react was four files, one of them 1,730
    # lines; interface/stdlib/dom's install.ts was 1,376; interface/stdlib/
    # bindings was one 778-line module covering nine unrelated OS facilities.
    #
    # Nothing was wrong with any of them by the checks above, because the
    # checks above never looked. These three do.

    # A package is a directory carrying a manifest.
    def packages(tier):
        seen = set()
        for pattern in ("**/package.json", "**/Cargo.toml"):
            for manifest in sorted((root / "solutions" / tier).glob(pattern)):
                if "node_modules" in manifest.parts:
                    continue
                seen.add(manifest.parent)
        return sorted(seen)

    # integrations/javascript/quickjs is a vendored upstream fork, kept in
    # rquickjs's own layout so the diff against upstream stays readable. It is
    # exempt from all three rules, and that exemption is the whole reason it
    # sits under a vendor-named directory.
    VENDORED = (root / "solutions" / "integrations" / "javascript" / "quickjs").resolve()

    def is_vendored(path):
        resolved = path.resolve()
        return resolved == VENDORED or VENDORED in resolved.parents

    # Rule 1: nothing but an entrypoint, a manifest and prose at a package root.
    #
    # "A folder structure, not just a bunch of files" is the whole point, and
    # this is the shape of it that can be checked: source at a package root is
    # a file that has not been given a role yet.
    ROOT_FILES_OK = {
        "index.ts", "lib.rs", "main.ts", "build.rs",          # entrypoints
        "package.json", "Cargo.toml", "BUILD.bazel",          # manifests
        "tsconfig.json", "build.zig", "build.zig.zon",
    }
    SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".rs", ".zig"}

    layout_violations = 0
    for tier in ("capabilities", "infrastructure", "integrations", "interface"):
        for package in packages(tier):
            if is_vendored(package):
                continue
            # A library is defined by being flat — pure computation with no
            # layers to name. plugin/sdk is four files at its root and
            # that is its declared shape, not drift.
            manifests = "".join(
                (package / name).read_text(encoding="utf-8", errors="replace")
                for name in ("package.json", "Cargo.toml")
                if (package / name).is_file()
            )
            if re.search(r'carbon[.\-_]?kind["\s:=]+"?library"?', manifests):
                continue

            for entry in sorted(package.iterdir()):
                if not entry.is_file():
                    continue
                if entry.name in ROOT_FILES_OK or entry.suffix not in SOURCE_SUFFIXES:
                    continue
                rel = entry.relative_to(root).as_posix()
                print(f"[FAIL] loose source at a package root: {rel}")
                print( "       Give it a role: a directory named for what it does.")
                print( "       Only an entrypoint belongs at a package root.")
                layout_violations += 1
                passed = False

    # Rule 2: one vocabulary per tier, for the two tiers that have one.
    #
    # infrastructure/ had `modules/`, `targets/` and `loader/` for the same
    # idea. integrations/ had `model/` + `core/` + `addons/` in one package,
    # `executors/` loose in another, and a `build/` holding two files that run
    # every frame. The names were each defensible alone and meant nothing
    # together.
    #
    # capabilities/ is deliberately absent: its shape is per-KIND, and the
    # rules that matter there are about dependencies (above). interface/ is
    # absent too, and that is stated in solutions/README.md rather than fudged
    # — a command framework and a React reconciler are not made of the same
    # parts, so a shared vocabulary would be invented rather than observed.
    TIER_DIRS = {
        "infrastructure": {"ports", "adapters", "tests", "abi"},
        "integrations": {"domain", "infrastructure", "tests", "types"},
    }
    for tier, allowed in TIER_DIRS.items():
        for package in packages(tier):
            if is_vendored(package):
                continue
            for entry in sorted(package.iterdir()):
                if not entry.is_dir() or entry.name.startswith("."):
                    continue
                if entry.name in allowed:
                    continue
                rel = entry.relative_to(root).as_posix()
                print(f"[FAIL] {tier}/ package has a directory outside its "
                      f"vocabulary: {rel}")
                print(f"       {tier}/ packages are made of "
                      f"{' + '.join(sorted(allowed))}. Nest below one of those.")
                layout_violations += 1
                passed = False

    # Rule 3: no src/ anywhere in solutions/.
    #
    # Layers sit at the package root — the same rule products/ has, for the
    # same reason: `src/` is a directory that says a file is source, which its
    # extension already said, and it pushes every meaningful name one level
    # down. Fourteen Rust crates put lib.rs at their root; plugin/sdk
    # was the fifteenth and did not, and nothing noticed.
    #
    # Two exceptions, both about code that is not ours to lay out. Zig's
    # convention is `src/`, and `templates/` scaffolds a plugin author's own
    # crate — where Cargo's convention is `src/lib.rs` and this repository's
    # preference is none of their business.
    for src in sorted((root / "solutions").rglob("src")):
        if not src.is_dir() or "node_modules" in src.parts:
            continue
        if is_vendored(src) or "zig" in src.parts or "templates" in src.parts:
            continue
        rel = src.relative_to(root).as_posix()
        print(f"[FAIL] src/ in solutions/: {rel}")
        print( "       Layers sit at the package root — see products/README.md.")
        layout_violations += 1
        passed = False

    if layout_violations == 0:
        print("[OK] Package layout: no loose source at a package root, one "
              "vocabulary per tier, no src/")

    if passed:
        print("\n[+] Workspace structure validation PASSED successfully!")
    else:
        print("\n[!] Workspace structure validation FAILED.")

    return passed

if __name__ == "__main__":
    workspace_root = Path(__file__).resolve().parent.parent.parent
    success = validate_workspace(workspace_root)
    sys.exit(0 if success else 1)
