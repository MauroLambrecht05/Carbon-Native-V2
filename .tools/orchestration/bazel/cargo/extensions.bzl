"""Bzlmod extension exposing the host's cargo to the workspace.

Deliberately smaller than the Bun extension next door: there is no version to
pick, because nothing is downloaded. Rust cannot be fetched hermetically here
without also vendoring a C toolchain — see defs.bzl — so this only records
where the host's cargo already is.
"""

load(":repositories.bzl", "cargo_repository")

def _cargo_impl(_module_ctx):
    cargo_repository(name = "carbon_cargo")

cargo = module_extension(
    implementation = _cargo_impl,
    doc = "Locates the host cargo and exposes it as @carbon_cargo.",
)
