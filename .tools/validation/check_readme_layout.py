#!/usr/bin/env python3
"""
Checks the layout README.md declares against the tree that exists.

WHY THIS EXISTS
---------------
README.md section 3 states what the workspace root, `.config/` and `.tools/`
contain. It is the only place that says so, and for most of the migration it
described a tree that had stopped being true — `solutions/shared/contracts/`,
`products/carbon-builder`, `solutions/internal/`, none of which existed. While
it was wrong about what WAS there, four things accumulated that it had never
mentioned: an 11 GB cargo target directory in `.tools/.build`, two committed
Windows executables in `.tools/vendor`, a stray tsconfig at the `.tools/` root,
and the Cargo workspace at `.config/rust`.

Neither failure is detectable by reading the document, which is the problem
with a layout that lives only in prose.

So this parses the tree blocks out of the README and checks BOTH directions:

    declared but absent   a path the document promises and the tree lacks
    present but undeclared  an entry that appeared without anyone deciding

The second is the one that matters. Drift into a directory is silent; drift out
of one usually breaks a build.

Usage:
    python .tools/validation/check_readme_layout.py [--quiet]
"""

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
README = ROOT / "README.md"

# Only these are checked in both directions. The tier directories are declared
# one level deep for orientation and are governed by their own READMEs and by
# the structural rules in check_workspace.py — listing every capability here
# would duplicate a list that already has an owner.
CLOSED = ["", ".config", ".tools"]


def declared_paths(readme: str) -> dict[str, set[str]]:
    """Every path the README's ```text blocks declare, keyed by parent."""
    by_parent: dict[str, set[str]] = {}

    for block in re.findall(r"```text\n(.*?)```", readme, re.S):
        lines = block.splitlines()
        if not lines:
            continue

        # The first line is the block's root: "V2/", ".config/", "products/".
        header = lines[0].strip().rstrip("/")
        base = "" if header == "V2" else header
        stack: list[str] = []

        for line in lines[1:]:
            # `├── name` / `└── name`, with `│   ` for each level above.
            match = re.match(r"^([│ ]*)[├└]── (.+)$", line)
            if not match:
                continue
            depth = len(match.group(1)) // 4
            # Strip the trailing comment, then the directory slash.
            name = match.group(2).split("#")[0].strip().rstrip("/")
            if not name:
                continue

            del stack[depth:]
            stack.append(name)

            parent = "/".join([base, *stack[:-1]]) if base else "/".join(stack[:-1])
            by_parent.setdefault(parent, set()).add(name)

    return by_parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet", action="store_true", help="only print failures")
    args = parser.parse_args()

    if not README.is_file():
        print("[FAIL] no README.md at the workspace root")
        return 1

    declared = declared_paths(README.read_text(encoding="utf-8"))
    if not declared:
        print("[FAIL] README.md declares no layout — the ```text blocks are gone")
        return 1

    failures = 0
    checked = 0

    # ── Declared but absent ────────────────────────────────────────────────
    for parent, names in sorted(declared.items()):
        for name in sorted(names):
            rel = f"{parent}/{name}" if parent else name
            checked += 1
            if not (ROOT / rel).exists():
                print(f"[FAIL] README.md declares {rel}, which does not exist")
                failures += 1

    # ── Present but undeclared ─────────────────────────────────────────────
    for parent in CLOSED:
        directory = ROOT / parent if parent else ROOT
        if not directory.is_dir():
            continue
        expected = declared.get(parent)
        if expected is None:
            print(f"[FAIL] README.md has no layout block for {parent or 'the workspace root'}")
            failures += 1
            continue

        for entry in sorted(directory.iterdir()):
            # .env is optional and machine-local by design (see .gitignore):
            # a developer may or may not have created one from .env.example,
            # so it can be either absent (a fresh clone, CI) or present
            # (a workstation) without either state being wrong. Declaring it
            # would make one of those two truths fail the other direction.
            if parent == "" and entry.name == ".env":
                continue
            # Bazel's convenience symlinks are created by a build, not by a
            # person, and their names depend on the workspace name.
            if entry.name.startswith("bazel-"):
                continue
            if entry.name in expected:
                continue
            rel = f"{parent}/{entry.name}" if parent else entry.name
            print(f"[FAIL] {rel} exists and README.md does not declare it")
            print( "       Either it does not belong there, or the layout in")
            print( "       README.md section 3 needs to say why it does.")
            failures += 1

    if failures:
        print(f"\n[!] README layout: {failures} disagreement(s) with the tree")
        return 1

    if not args.quiet:
        print(f"[OK] README layout: {checked} declared paths, and nothing undeclared "
              f"in {len(CLOSED)} closed directories")
    return 0


if __name__ == "__main__":
    sys.exit(main())
