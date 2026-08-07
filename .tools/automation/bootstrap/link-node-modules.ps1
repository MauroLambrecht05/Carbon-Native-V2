# Links <workspace>/node_modules -> <workspace>/.config/node_modules
#
# The npm manifest lives in .config/ so the workspace root stays Bazel-only.
# Bun and Node resolve packages by walking UP the directory tree from each
# importing file, so a node_modules that only exists inside .config/ is
# invisible to everything in products/ and solutions/. This junction is what
# makes the relocation work.
#
# A junction (not a symlink) because junctions need no Developer Mode and no
# elevation on Windows.
#
#   bun install --cwd .config
#   .\.tools\automation\bootstrap\link-node-modules.ps1

$ErrorActionPreference = "Stop"

$workspace = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$target = Join-Path $workspace ".config\node_modules"
$link = Join-Path $workspace "node_modules"

if (-not (Test-Path $target)) {
    Write-Error "no $target - run 'bun install --cwd .config' from $workspace first"
}

if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType) {
        Write-Host "already linked: $link -> $($item.Target)"
        exit 0
    }
    Write-Error "$link exists and is a real directory, not a link. Remove it and re-run."
}

New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "linked $link -> $target"
