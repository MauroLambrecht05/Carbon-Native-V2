#!/usr/bin/env python3
"""
Carbon Native V2 - Workspace Structure & Boundary Validator
Ensures directory invariants, BUILD file presence, and module boundary hygiene.
"""

import json
import re
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
        "distribution", "toolchain",
    ]
    CAPABILITIES = [
        "signing", "updating", "bundling", "packaging", "publishing",
        "scaffolding", "plugins",
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
        definitions = list(contract.glob("schema/*.fbs")) + list(contract.glob("schema/*.json")) +             list(contract.glob("abi/*.h")) + list(contract.glob("schema/*.fbs")) + list(contract.glob("schema/*.json")) + list(contract.glob("types/*.ts"))
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

    if passed:
        print("\n[+] Workspace structure validation PASSED successfully!")
    else:
        print("\n[!] Workspace structure validation FAILED.")

    return passed

if __name__ == "__main__":
    workspace_root = Path(__file__).resolve().parent.parent.parent
    success = validate_workspace(workspace_root)
    sys.exit(0 if success else 1)
