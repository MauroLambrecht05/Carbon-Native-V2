"""`workspace_check` — Bazel targets for checks that read the whole source tree.

WHY THESE CANNOT BE ORDINARY sh_test TARGETS
--------------------------------------------
A normal Bazel test declares its inputs and runs against a tree containing
exactly those. That is the right model for a unit test and the wrong one for
every check in this file's callers, because each one's entire job is to notice
files nobody declared:

  * check_workspace.py   walks the root looking for entries that should not be
                         there, and discovers every tsconfig to run tsc on
  * check_host_boundary  greps both sides of an FFI boundary for string literals
  * boundaries.ts        hunts for stray lockfiles and uncheckummed binaries

Declaring their inputs would mean declaring the thing being checked, so a file
sneaking in unnoticed is also a file the check never sees. They have to run
against the real checkout.

HOW THEY FIND IT
----------------
`bazel run` exports BUILD_WORKSPACE_DIRECTORY. `bazel test` does not, and leaves
the working directory in the execroot — the same problem the cargo and bun
launchers hit, solved the same way: @carbon_cargo captures the workspace root at
FETCH time, when the real environment is visible, and the launcher falls back to
it. That is why this loads WORKSPACE_ROOT from the cargo repo rule rather than
introducing a second mechanism for the same fact.

WHAT THIS COSTS
---------------
No sandboxing and no caching. `no-cache` is deliberate: a cached PASS from
before the tree changed is exactly the failure mode these checks exist to
prevent, and Bazel cannot know the tree changed when the tree is not an input.
They are fast — a few seconds each — so re-running always is cheap.
"""

load("@carbon_cargo//:defs.bzl", "WORKSPACE_ROOT")

_SH = """\
#!/usr/bin/env bash
set -euo pipefail

if [ -n "${{BUILD_WORKSPACE_DIRECTORY:-}}" ]; then
  cd "$BUILD_WORKSPACE_DIRECTORY"
elif [ -d "{workspace_root}" ]; then
  cd "{workspace_root}"
else
  echo "error: cannot locate the workspace root." >&2
  echo "  BUILD_WORKSPACE_DIRECTORY unset and {workspace_root} does not exist." >&2
  echo "  Re-fetch @carbon_cargo, which captures it: bazel sync --configure" >&2
  exit 1
fi

{py_probe}exec {command}
"""

# Emitted only for checks whose command actually needs an interpreter. Keeping
# it out of the others is not tidiness — see the Windows note below.
_PY_PROBE_SH = """\
PY=""
python3 --version >/dev/null 2>&1 && PY=python3
[ -z "$PY" ] && python --version >/dev/null 2>&1 && PY=python
if [ -z "$PY" ]; then
  echo "error: no working python interpreter found (tried python3, python)." >&2
  exit 1
fi

"""

# Finding python on Windows without setting off a Store install.
#
# `python.exe`, `python3.exe` and `py.exe` on a current Windows 11 are App
# Execution Aliases in front of pymanager, not interpreters. INVOKING one — even
# `--version` — can hand control to the package manager, which installs a
# runtime into the CURRENT DIRECTORY. A check runs from the workspace root, so
# that lands a "Python" folder inside the workspace, which the root-hygiene and
# committed-binaries rules then correctly flag.
#
# Observed rather than theorised, and twice: first from `python3`, then from
# `py -3` after that was supposedly the safe alternative. Even a check that only
# runs `bun` triggered it, because the probe used to be emitted unconditionally.
#
# So: resolve a path with `where` (which does not execute anything) and take the
# first hit outside WindowsApps. Nothing is invoked until the real command runs.
_PY_PROBE_BAT = """\
set "PY="
for /f "delims=" %%P in ('where python 2^>nul') do (
  if "!PY!"=="" echo %%P | findstr /i /c:"WindowsApps" >nul || set "PY=%%P"
)
if "!PY!"=="" (
  for /f "delims=" %%P in ('where python3 2^>nul') do (
    if "!PY!"=="" echo %%P | findstr /i /c:"WindowsApps" >nul || set "PY=%%P"
  )
)
if "!PY!"=="" (
  echo error: no usable python interpreter found. 1>&2
  echo   `where python` returned nothing outside WindowsApps App Execution 1>&2
  echo   Aliases, which are Store stubs rather than interpreters. 1>&2
  echo   Install from python.org or: winget install Python.Python.3.12 1>&2
  exit /b 1
)

"""

_BAT = """\
@echo off
rem enabledelayedexpansion is required: the interpreter probe below sets %PY%
rem inside a for-loop body, and without it every !PY! in that block expands to
rem the value from before the loop started — i.e. empty.
setlocal enabledelayedexpansion

if not "%BUILD_WORKSPACE_DIRECTORY%"=="" cd /d "%BUILD_WORKSPACE_DIRECTORY%"
if "%BUILD_WORKSPACE_DIRECTORY%"=="" if exist "{workspace_root_win}" cd /d "{workspace_root_win}"

{py_probe_win}{command_win}
exit /b %ERRORLEVEL%
"""

def _impl(ctx):
    # The interpreter probe is emitted ONLY when the command references it.
    # A check that runs `bun` must not go looking for python — on Windows the
    # act of looking is what installs one into the workspace.
    needs_py = "$PY" in ctx.attr.command

    if ctx.attr.is_windows:
        launcher = ctx.actions.declare_file(ctx.label.name + ".bat")
        content = _BAT.format(
            workspace_root_win = WORKSPACE_ROOT.replace("/", "\\"),
            py_probe_win = _PY_PROBE_BAT if needs_py else "",
            command_win = " ".join(ctx.attr.command).replace("$PY", "!PY!"),
        )
        # cmd.exe parses a .bat line by line as it executes; LF-only endings make
        # it chew through line boundaries. Same trap as the cargo and bun rules.
        content = content.replace("\n", "\r\n")
    else:
        launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
        content = _SH.format(
            workspace_root = WORKSPACE_ROOT,
            py_probe = _PY_PROBE_SH if needs_py else "",
            command = " ".join(ctx.attr.command),
        )

    ctx.actions.write(launcher, content, is_executable = True)
    return [DefaultInfo(
        executable = launcher,
        runfiles = ctx.runfiles(files = ctx.files.data),
    )]

_ATTRS = {
    "command": attr.string_list(
        mandatory = True,
        doc = "argv to exec from the workspace root. `$PY` expands to python3/python.",
    ),
    "data": attr.label_list(allow_files = True),
    "is_windows": attr.bool(mandatory = True),
}

_workspace_check_test = rule(
    implementation = _impl,
    attrs = _ATTRS,
    test = True,
)

_workspace_check_binary = rule(
    implementation = _impl,
    attrs = _ATTRS,
    executable = True,
)

_WINDOWS = select({
    "@platforms//os:windows": True,
    "//conditions:default": False,
})

# See the module docstring for why these three tags are not negotiable.
_TAGS = ["no-sandbox", "no-cache", "external"]

def workspace_check_test(name, command, **kwargs):
    """A tree-wide check, as a `bazel test` target."""
    tags = kwargs.pop("tags", [])
    _workspace_check_test(
        name = name,
        command = command,
        is_windows = _WINDOWS,
        tags = tags + [t for t in _TAGS if t not in tags],
        **kwargs
    )

def workspace_check_binary(name, command, **kwargs):
    """A tree-wide check that is only ever run explicitly, via `bazel run`."""
    tags = kwargs.pop("tags", [])
    _workspace_check_binary(
        name = name,
        command = command,
        is_windows = _WINDOWS,
        tags = tags + [t for t in _TAGS if t not in tags],
        **kwargs
    )
