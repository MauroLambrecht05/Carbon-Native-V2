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
    CAPABILITIES = [
        # TypeScript
        "signing", "updating", "bundling", "packaging", "publishing",
        "scaffolding", "plugins",
        # Rust, migrated from V1's carbon/ — see products/carbon/MIGRATION.md
        "math", "text", "snapshot", "imaging", "audio",
    ]
    INFRASTRUCTURE = ["logging", "process", "workspace"]

    contract_dirs = ["solutions/contracts/" + s for s in CONTRACT_SUBJECTS]

    # Products follow one template — see products/README.md.
    product_dirs = [
        "products/carbon-cli",
        "products/carbon-cli/composition",
        "products/carbon-cli/presentation",
        "products/carbon-cli/presentation/commands",
        "products/carbon-cli/tests",
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

    # Root hygiene. Container/dev-env files belong in
    # solutions/shared/infrastructure. The npm manifests belong in .config —
    # the workspace root is Bazel's, and only Bazel's.
    root_prohibited = [
        "Dockerfile",
        "docker-compose.yml",
        ".devcontainer",
        "package.json",
        "bun.lock",
        "bun.lockb",
        "tsconfig.json",
    ]
    for item in root_prohibited:
        p = root / item
        if p.exists():
            print(f"[FAIL] Prohibited item in workspace root: {item}")
            passed = False
        else:
            print(f"[OK] Clean workspace root (no {item})")

    required_files = [
        # Bazel — the only source files permitted at the workspace root.
        "MODULE.bazel",
        "BUILD.bazel",
        ".bazelrc",
        ".bazelversion",
        # Central configuration, including the relocated npm manifest and the
        # path aliases that replaced bun workspaces.
        ".config/_identity.json",
        ".config/build.json",
        ".config/package.json",
        ".config/tsconfig.base.json",
        "labs/README.md",
        # Contracts.
        "solutions/contracts/plugin/abi/carbon_abi.h",
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
        "solutions/capabilities/signing/index.ts",
        "solutions/capabilities/updating/index.ts",
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
    for domain_dir in root.glob("solutions/capabilities/*/domain"):
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

    for lib in sorted(root.glob("solutions/capabilities/*/lib.rs")):
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
    template_violations = 0
    for manifest in sorted(root.glob("products/*/package.json")):
        product = manifest.parent
        name = product.name

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
    shape_violations = 0
    for capability in sorted((root / "solutions" / "capabilities").iterdir()):
        if not capability.is_dir():
            continue
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

    if passed:
        print("\n[+] Workspace structure validation PASSED successfully!")
    else:
        print("\n[!] Workspace structure validation FAILED.")

    return passed

if __name__ == "__main__":
    workspace_root = Path(__file__).resolve().parent.parent.parent
    success = validate_workspace(workspace_root)
    sys.exit(0 if success else 1)
