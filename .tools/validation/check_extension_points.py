#!/usr/bin/env python3
"""
Checks the extension-point registry against the three renderings of it.

WHY THIS EXISTS
---------------
`solutions/contracts/plugin/registry/extension-points.zig` declares every place
a plugin can plug in. Three other files say the same thing in other languages,
because the parties that have to agree cannot all read Zig:

    abi/carbon_extension_points.h   what a plugin author compiles against
    rust/generated.rs               the table the runtime dispatches through
    types/ExtensionPoints.ts        what the toolchain validates manifests with

All three are GENERATED. Nothing in a compiler or a test suite notices when one
of them stops matching the Zig: the C header is only read by plugin authors, the
Rust still compiles because it is self-consistent, and the TypeScript still
typechecks. The failure mode is a plugin that compiles against a prototype the
runtime does not dispatch, discovered by a user whose app is missing a feature.

This is the thing that notices. It is the same shape of problem, and the same
answer, as `check_host_boundary.py` one boundary over.

Usage:
    python .tools/validation/check_extension_points.py [--quiet]

Delegates to `carbon ext check`, which owns the comparison: re-rendering the
registry here in Python would be a fourth implementation of the generator, and
a fourth one to keep in step.
"""

import argparse
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
REGISTRY = ROOT / "solutions/contracts/plugin/registry/extension-points.zig"
# `carbon ext check`. It lives in carbon-cli because it is a command, and
# every command is carbon-cli — it spent one revision as a second CLI in
# products/carbon-ext, which is now the SDK itself rather than a tool.
ENTRY = ROOT / "products/carbon-cli/main.ts"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet", action="store_true", help="only print failures")
    args = parser.parse_args()

    if not REGISTRY.is_file():
        print(f"[FAIL] no extension-point registry at {REGISTRY.relative_to(ROOT).as_posix()}")
        return 1
    if not ENTRY.is_file():
        print(f"[FAIL] carbon-cli is missing: {ENTRY.relative_to(ROOT).as_posix()}")
        return 1

    result = subprocess.run(
        ["bun", str(ENTRY), "ext", "check"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        shell=(sys.platform == "win32"),
    )

    if result.returncode != 0:
        print("[FAIL] Extension points: a generated artifact no longer matches the registry")
        for line in (result.stdout + result.stderr).strip().splitlines():
            print(f"       {line}")
        return 1

    if not args.quiet:
        # The point count comes from carbon-ext, so this line cannot claim a
        # coverage the tool did not actually check.
        summary = next(
            (l for l in result.stdout.splitlines() if "extension points" in l),
            "every rendering matches the registry",
        )
        print(f"[OK] Extension points: {summary.strip()}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
