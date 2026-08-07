"""Contract subject macros.

A contract subject is everything two parties must agree on *about one thing* —
its wire schema, its native ABI, its config schema, its shared types. The
subject is the directory; the kinds are folders inside it.

Every subject's BUILD.bazel is a single call into this file. The shape is
per-subject so each can be found, documented and versioned on its own; the rule
lives once so eight subjects cannot make the same mistake eight times.

They did exactly that before: each hand-rolled `flatbuffer_cc_library` and each
passed a filegroup instead of the .fbs, so the declared output name never
matched what flatc produced. Every subject failed, and being an analysis-time
failure it silently skipped every test in the workspace.
"""

load("@flatbuffers//:build_defs.bzl", "flatbuffer_cc_library")

def flatbuffers_subject(name, visibility = ["//visibility:public"]):
    """A subject whose agreement is a wire format: schema/*.fbs.

    Breaking one is a WIRE break — peers built at different versions stop
    understanding each other. Add fields; never renumber or remove.
    """
    schemas = native.glob(["schema/*.fbs"])

    # srcs takes the .fbs files DIRECTLY. flatbuffer_cc_library derives its
    # declared outputs from the source file names, so a filegroup makes it
    # declare `<group>_generated.h` while flatc writes `<basename>_generated.h`.
    flatbuffer_cc_library(
        name = name + "_cc_fbs",
        srcs = schemas,
        visibility = visibility,
    )

    native.filegroup(name = "srcs", srcs = native.glob(["**/*.fbs", "**/*.h", "**/*.ts"]), visibility = visibility)
    native.exports_files(schemas)

def json_schema_subject(name, visibility = ["//visibility:public"]):
    """A subject whose agreement is a document humans write: schema/*.json.

    Breaking one is a CONFIG break — projects already on disk stop loading, and
    unlike a wire break there is no recompile that fixes them. Their authors
    have to edit files.
    """
    native.filegroup(
        name = name,
        srcs = native.glob(["schema/*.json"]),
        visibility = visibility,
    )
    native.filegroup(name = "srcs", srcs = native.glob(["**/*.json", "**/*.ts"]), visibility = visibility)
    native.exports_files(native.glob(["schema/*.json"]))

def abi_subject(name, visibility = ["//visibility:public"]):
    """A subject whose agreement is a native header: abi/*.h.

    Breaking one is an ABI break — every native tier must be recompiled, and
    prebuilt plugins already on disk stop loading. Layout and enum values are
    frozen once shipped.
    """
    native.cc_library(
        name = name + "_abi",
        hdrs = native.glob(["abi/*.h"]),
        includes = ["abi"],
        visibility = visibility,
    )
    native.exports_files(native.glob(["abi/*.h"]))
