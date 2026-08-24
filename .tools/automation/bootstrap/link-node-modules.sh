#!/usr/bin/env bash
# Links <workspace>/node_modules -> <workspace>/.config/node_modules
#
# The npm manifest lives in .config/ so the workspace root stays Bazel-only.
# Bun and Node resolve packages by walking UP the directory tree from each
# importing file, so a node_modules that only exists inside .config/ is
# invisible to everything in products/ and solutions/. This symlink is what
# makes the relocation work.
#
#   bun install --cwd .config
#   ./.tools/automation/bootstrap/link-node-modules.sh

set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
target="$workspace/.config/node_modules"
link="$workspace/node_modules"

if [ ! -d "$target" ]; then
  echo "error: no $target - run 'bun install --cwd .config' from $workspace first" >&2
  exit 1
fi

if [ -L "$link" ]; then
  echo "already linked: $link -> $(readlink "$link")"
  exit 0
fi

if [ -e "$link" ]; then
  echo "error: $link exists and is a real directory, not a link. Remove it and re-run." >&2
  exit 1
fi

ln -s .config/node_modules "$link"
echo "linked $link -> $target"
