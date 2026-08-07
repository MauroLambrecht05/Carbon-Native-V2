"""Bzlmod module extension that materialises the Bun toolchain repositories."""

load(":repositories.bzl", "BUN_PLATFORMS", "bun_hub_repo", "bun_platform_repo")

_DEFAULT_VERSION = "1.3.10"

def _bun_impl(module_ctx):
    version = _DEFAULT_VERSION
    for module in module_ctx.modules:
        for toolchain in module.tags.toolchain:
            if toolchain.version:
                version = toolchain.version

    for platform in BUN_PLATFORMS.keys():
        bun_platform_repo(
            name = "bun_" + platform,
            platform = platform,
            version = version,
        )

    bun_hub_repo(name = "bun_toolchains")

bun = module_extension(
    implementation = _bun_impl,
    tag_classes = {
        "toolchain": tag_class(attrs = {
            "version": attr.string(doc = "Bun release to pin, e.g. 1.3.10."),
        }),
    },
)
