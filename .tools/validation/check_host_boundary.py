#!/usr/bin/env python3
"""
Checks the JS <-> Rust boundary against its declaration.

WHY THIS EXISTS
---------------
The runtime installs 139 functions onto a QuickJS context and JavaScript calls
them by string name. Thirty-four more go the other way: JavaScript installs
them and Rust calls them — from inside an eval'd JS string literal, like

    globalThis.__cm_dispatch_click && globalThis.__cm_dispatch_click({});

Nothing in the toolchain can see across that. rustc sees a string. tsc sees a
global it was told about in a hand-maintained `declare global` block. A typo, a
rename, or a function quietly dropped during a refactor produces no build error
on either side — just an app that stops responding to clicks.

`solutions/contracts/runtime/registry/host-boundary.toml` is the declaration.
This compares it against what the source actually does.

Usage:
    python .tools/validation/check_host_boundary.py [--source <dir>]

    --source defaults to this workspace. Point it at a V1 checkout to check the
    migration against the original.
"""

import argparse
import pathlib
import re
import sys

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib  # type: ignore

REGISTRY = (
    pathlib.Path(__file__).resolve().parent.parent.parent
    / "solutions/contracts/runtime/registry/host-boundary.toml"
)

# Where Rust that touches the boundary lives. Both the V1 layout and the V2 one,
# so this works during the migration and after it.
RUST_GLOBS = [
    "carbon/host/native/*.rs",
    "carbon/api/*.rs",
    "carbon/runtime/mini.rs",
    "carbon/runtime/blitz.rs",
    "solutions/infrastructure/os/**/*.rs",
    "solutions/infrastructure/plugin-host/**/*.rs",
    "products/carbon/**/*.rs",
]

NAME = re.compile(r"__cm_[a-z0-9_]+")


def rust_sources(root: pathlib.Path) -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for pattern in RUST_GLOBS:
        found.extend(sorted(root.glob(pattern)))
    return [f for f in found if f.is_file()]


def scan(root: pathlib.Path) -> tuple[set[str], set[str]]:
    """(registered, referenced) — names Rust installs, and names it mentions."""
    registered: set[str] = set()
    referenced: set[str] = set()

    for path in rust_sources(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        # A quoted name is a registration: `g.set("__cm_os_platform", ...)`.
        registered |= set(re.findall(r'"(__cm_[a-z0-9_]+)"', text))
        # Anything else is a mention, including inside evaluated JS.
        referenced |= set(NAME.findall(text))

    return registered, referenced


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, default=REGISTRY.parents[4])
    args = parser.parse_args()

    if not REGISTRY.is_file():
        print(f"[FAIL] no registry at {REGISTRY}")
        return 1

    declared = tomllib.loads(REGISTRY.read_text(encoding="utf-8"))
    imports = {n for mod in declared["imports"].values() for n in mod["functions"]}
    dispatchers = set(declared["dispatchers"]["functions"])

    registered, referenced = scan(args.source.resolve())

    if not registered and not referenced:
        # No Rust to check yet — the migration has not reached the host layer.
        # Report it rather than passing silently, which would look identical to
        # "everything agrees".
        print(f"[SKIP] no boundary-touching Rust found under {args.source}")
        print(f"       registry declares {len(imports)} imports, "
              f"{len(dispatchers)} dispatchers")
        return 0

    failures = 0

    missing = imports - registered
    if missing:
        failures += len(missing)
        print(f"[FAIL] {len(missing)} declared import(s) not registered in Rust:")
        for name in sorted(missing):
            print(f"         {name}")

    undeclared = registered - imports
    if undeclared:
        failures += len(undeclared)
        print(f"[FAIL] {len(undeclared)} function(s) registered but not declared:")
        for name in sorted(undeclared):
            print(f"         {name}")

    # A dispatcher Rust no longer mentions is an event that stopped being
    # delivered. Nothing else would notice.
    unused = dispatchers - referenced
    if unused:
        failures += len(unused)
        print(f"[FAIL] {len(unused)} declared dispatcher(s) never called from Rust:")
        for name in sorted(unused):
            print(f"         {name}")

    if failures:
        print(f"\n[!] Host boundary differs from its declaration ({failures} issue(s)).")
        return 1

    print(f"[OK] Host boundary: {len(imports)} imports, "
          f"{len(dispatchers)} dispatchers, all accounted for")
    return 0


if __name__ == "__main__":
    sys.exit(main())
