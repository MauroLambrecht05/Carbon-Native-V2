#!/usr/bin/env python3
"""
Typechecks every TypeScript project in the workspace.

WHY THIS EXISTS
---------------
There is no longer one TypeScript project. Most of the tree compiles under
`solutions/tsconfig.json`, but five packages cannot:

  interface/renderer/solid       lib DOM + --jsx (solid-js types name DOM)
  interface/renderer/react       lib DOM + --jsx (react-reconciler does too)
  integrations/terminal/xterm    lib DOM (it is API-compatible with xterm.js,
                                 whose surface is HTMLElement and friends)
  integrations/scene3d/three     lib DOM (three.js declarations name it)
  integrations/scene3d/three-fiber  lib DOM + --jsx

Those options must NOT reach the rest of the tree. carbon has no DOM, and with
lib DOM in scope a stray `document.getElementById` compiles cleanly and fails at
runtime — which is the whole class of bug the runtime exists to avoid.

So each carries its own tsconfig, and something has to run all of them. Running
them by hand is how one gets forgotten: `solutions/tsconfig.json` reporting zero
errors would look identical whether it covers the tree or half of it. That has
already happened twice in this repository, both times a stale `include`.

This discovers projects rather than listing them, so a package added tomorrow is
checked without anyone remembering to come here.

Usage:
    python .tools/validation/check_typescript.py [--quiet]
"""

import argparse
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent

# Where to look. Anything with a tsconfig.json under these is a project.
SEARCH = ["solutions", "products"]

# Not projects: .config holds the shared base (no inputs of its own), and
# labs/ is scratch space that is deliberately not built.
SKIP_PARTS = {"node_modules", ".config", "labs", ".build"}


def is_project(path: pathlib.Path) -> bool:
    """A tsconfig with no `include`/`files` is a base, not a project."""
    if any(part in SKIP_PARTS for part in path.parts):
        return False
    try:
        # tsconfigs carry // comments, which json cannot parse.
        text = re.sub(r"^\s*//.*$", "", path.read_text(encoding="utf-8"), flags=re.M)
        config = json.loads(text)
    except Exception:
        # Unparseable is worth reporting, so treat it as a project and let tsc
        # produce the real message.
        return True
    return "include" in config or "files" in config


def projects() -> list[pathlib.Path]:
    found = []
    for base in SEARCH:
        for cfg in sorted((ROOT / base).rglob("tsconfig.json")):
            if is_project(cfg):
                found.append(cfg)
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet", action="store_true",
                        help="only print failures")
    args = parser.parse_args()

    found = projects()
    if not found:
        print("[FAIL] no TypeScript projects found — the search paths are wrong")
        return 1

    failures = 0
    for cfg in found:
        rel = cfg.relative_to(ROOT).as_posix()
        result = subprocess.run(
            ["bunx", "tsc", "-p", str(cfg), "--noEmit"],
            capture_output=True,
            text=True,
            cwd=ROOT,
            shell=(sys.platform == "win32"),
        )
        errors = [l for l in result.stdout.splitlines() if "error TS" in l]

        if errors:
            failures += 1
            print(f"[FAIL] {rel}: {len(errors)} error(s)")
            for line in errors[:10]:
                print(f"         {line}")
            if len(errors) > 10:
                print(f"         ... and {len(errors) - 10} more")
        elif not args.quiet:
            print(f"[OK]   {rel}")

    if failures:
        print(f"\n[!] {failures} of {len(found)} TypeScript project(s) failed.")
        return 1

    print(f"[OK] TypeScript: {len(found)} project(s), no errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
