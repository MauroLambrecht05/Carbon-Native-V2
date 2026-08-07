# Carbon Native V2 — development environment.
#
# REWRITTEN, NOT RESTORED. The original solutions/shared/infrastructure/docker/
# Dockerfile was deleted during the solutions restructure and no copy survived
# (V2 is not in git). Its contents were never read, so this is a new file built
# from what the workspace actually declares, not a reconstruction. Treat it as
# a starting point and check it against what you had in mind.
#
# Every version below is pinned from a file in the repository, so this image
# and a local checkout agree:
#
#   Bazel   .bazelversion
#   Rust    .config/dependencies.json + .config/toolchains/rust/config.json
#   Zig     .config/dependencies.json + .config/toolchains/zig/config.json
#   Go      .config/dependencies.json
#   LLVM    .config/dependencies.json  (C++20, clang is the recommended compiler)
#   Bun     .tools/orchestration/bazel/bun/extensions.bzl
#
# Bazel fetches its own Rust, Go and C++ toolchains through Bzlmod, so strictly
# they are not required here. They are installed anyway because the dev loop
# does not always go through Bazel — `bun main.ts build` shells out to cargo
# directly, and a container without it fails at a confusing point.

FROM debian:bookworm-slim

ARG BAZELISK_VERSION=1.28.1
ARG BUN_VERSION=1.3.10
ARG RUST_VERSION=1.86.0
ARG ZIG_VERSION=0.12.0
ARG GO_VERSION=1.22.0
ARG LLVM_VERSION=17

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/usr/local/go/bin:/usr/local/bun/bin:/usr/local/zig:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git unzip xz-utils \
        build-essential python3 python3-venv \
        # libxkbcommon: the runtime's windowing layer needs it on Linux, and it
        # is the dependency people hit last and diagnose slowest.
        libxkbcommon-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

# ── Bazel, via bazelisk so .bazelversion is honoured ─────────────────────────
RUN curl -fsSL -o /usr/local/bin/bazel \
        "https://github.com/bazelbuild/bazelisk/releases/download/v${BAZELISK_VERSION}/bazelisk-linux-amd64" \
    && chmod +x /usr/local/bin/bazel

# ── LLVM/clang, for C++20 ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        clang-${LLVM_VERSION} lld-${LLVM_VERSION} \
    && ln -sf /usr/bin/clang-${LLVM_VERSION} /usr/bin/clang \
    && ln -sf /usr/bin/clang++-${LLVM_VERSION} /usr/bin/clang++ \
    && rm -rf /var/lib/apt/lists/*

# ── Rust ─────────────────────────────────────────────────────────────────────
RUN curl -fsSL https://sh.rustup.rs | sh -s -- \
        -y --no-modify-path --profile minimal \
        --default-toolchain ${RUST_VERSION} \
        --component rustfmt clippy

# ── Zig ──────────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-x86_64-${ZIG_VERSION}.tar.xz" \
        | tar -xJ -C /usr/local \
    && mv /usr/local/zig-linux-x86_64-${ZIG_VERSION} /usr/local/zig

# ── Go ───────────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
        | tar -xz -C /usr/local

# ── Bun — the TypeScript tier runs on it, not Node ───────────────────────────
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s "bun-v${BUN_VERSION}"

WORKDIR /workspace

# The npm manifest lives in .config/, and module resolution walks UP from each
# importing file — so the root needs a link into it. See
# .tools/automation/bootstrap/link-node-modules.sh.
CMD ["bash", "-lc", "bun install --cwd .config && ./.tools/automation/bootstrap/link-node-modules.sh && exec bash"]
