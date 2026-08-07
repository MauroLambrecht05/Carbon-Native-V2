"""Repository rules that download a pinned Bun per host platform."""

# Bun publishes one zip per platform, each containing a single directory of the
# same name holding the executable.
BUN_PLATFORMS = {
    "windows-x64": struct(
        asset = "bun-windows-x64",
        exe = "bun.exe",
        constraints = ["@platforms//os:windows", "@platforms//cpu:x86_64"],
    ),
    "linux-x64": struct(
        asset = "bun-linux-x64",
        exe = "bun",
        constraints = ["@platforms//os:linux", "@platforms//cpu:x86_64"],
    ),
    "linux-aarch64": struct(
        asset = "bun-linux-aarch64",
        exe = "bun",
        constraints = ["@platforms//os:linux", "@platforms//cpu:aarch64"],
    ),
    "darwin-x64": struct(
        asset = "bun-darwin-x64",
        exe = "bun",
        constraints = ["@platforms//os:macos", "@platforms//cpu:x86_64"],
    ),
    "darwin-aarch64": struct(
        asset = "bun-darwin-aarch64",
        exe = "bun",
        constraints = ["@platforms//os:macos", "@platforms//cpu:aarch64"],
    ),
}

_BUILD_TEMPLATE = """\
load("@carbon_native//.tools/orchestration/bazel/bun:toolchain.bzl", "bun_toolchain")

package(default_visibility = ["//visibility:public"])

exports_files(["{exe}"])

bun_toolchain(
    name = "bun_toolchain",
    bun = "{exe}",
    version = "{version}",
)
"""

def _bun_platform_repo_impl(rctx):
    platform = BUN_PLATFORMS[rctx.attr.platform]
    url = "https://github.com/oven-sh/bun/releases/download/bun-v{version}/{asset}.zip".format(
        version = rctx.attr.version,
        asset = platform.asset,
    )

    # NOTE: no sha256 is pinned yet, so Bazel re-verifies nothing and prints a
    # warning on first fetch. Pin these before this is used for release builds —
    # an unpinned toolchain download is exactly the supply-chain hole the
    # signer exists to close elsewhere.
    rctx.download_and_extract(
        url = url,
        stripPrefix = platform.asset,
    )

    rctx.file("BUILD.bazel", _BUILD_TEMPLATE.format(
        exe = platform.exe,
        version = rctx.attr.version,
    ))

bun_platform_repo = repository_rule(
    implementation = _bun_platform_repo_impl,
    attrs = {
        "platform": attr.string(mandatory = True, values = BUN_PLATFORMS.keys()),
        "version": attr.string(mandatory = True),
    },
)

_HUB_TEMPLATE = """\
toolchain(
    name = "{platform}_toolchain",
    exec_compatible_with = {constraints},
    target_compatible_with = [],
    toolchain = "@bun_{platform}//:bun_toolchain",
    toolchain_type = "@carbon_native//.tools/orchestration/bazel/bun:toolchain_type",
)
"""

def _bun_hub_repo_impl(rctx):
    lines = ['package(default_visibility = ["//visibility:public"])\n']
    for name, platform in BUN_PLATFORMS.items():
        lines.append(_HUB_TEMPLATE.format(
            platform = name,
            constraints = repr(platform.constraints).replace("'", '"'),
        ))
    rctx.file("BUILD.bazel", "\n".join(lines))

bun_hub_repo = repository_rule(
    implementation = _bun_hub_repo_impl,
)
