"""Toolchain plumbing for a pinned, hermetic Bun.

Bazel has no first-party Bun support and there is no rules_bun in the Bazel
Central Registry, so carbon-native declares its own. This is deliberately small:
it resolves one executable and hands it to `bun_binary` / `bun_test`.
"""

BunInfo = provider(
    doc = "The resolved Bun executable.",
    fields = {
        "bun": "File: the bun executable.",
        "version": "string: the pinned Bun release, e.g. 1.3.10.",
    },
)

def _bun_toolchain_impl(ctx):
    return [platform_common.ToolchainInfo(
        buninfo = BunInfo(
            bun = ctx.file.bun,
            version = ctx.attr.version,
        ),
    )]

bun_toolchain = rule(
    implementation = _bun_toolchain_impl,
    doc = "Wraps a downloaded bun executable as a Bazel toolchain.",
    attrs = {
        "bun": attr.label(
            allow_single_file = True,
            mandatory = True,
            doc = "The bun executable for this platform.",
        ),
        "version": attr.string(mandatory = True),
    },
)
