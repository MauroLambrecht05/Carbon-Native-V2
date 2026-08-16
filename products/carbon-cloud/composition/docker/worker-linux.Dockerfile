# Carbon Cloud — Linux build worker.
#
# Scoped to what a Linux build actually needs: Rust (ensureRuntime compiles
# carbon-mini/carbon-blitz from source on first use — see
# BuildProjectUseCase.ts's ensureRuntime), Bun (the worker process itself,
# and everything it shells out to for bundling), git (checkout), and
# dpkg-deb + appimagetool (the two toolchains
# solutions/capabilities/packaging/infrastructure/builders/ invoke).
#
# NOT the full dev environment in .tools/environments/docker/Dockerfile —
# this worker never runs Bazel, Zig, Go or LLVM, so it doesn't carry them.

FROM debian:bookworm-slim

ARG BUN_VERSION=1.3.10
ARG RUST_VERSION=1.88.0
# appimagetool has no versioned releases — "continuous" is the only tag
# upstream publishes (confirmed against the real GitHub API; a guessed "13"
# 404'd building this image for real).
ARG APPIMAGETOOL_VERSION=continuous

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/bun/bin:$PATH \
    # No FUSE inside a container; appimagetool falls back to extracting
    # itself and running from there when this is set.
    APPIMAGE_EXTRACT_AND_RUN=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip git dpkg-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://sh.rustup.rs | sh -s -- \
        -y --no-modify-path --profile minimal --default-toolchain ${RUST_VERSION}

RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s "bun-v${BUN_VERSION}"

RUN curl -fsSL -o /usr/local/bin/appimagetool \
        "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-x86_64.AppImage" \
    && chmod +x /usr/local/bin/appimagetool

WORKDIR /app
COPY . .

# See control-plane.Dockerfile's identical step for why this is needed at
# all: the real node_modules lives in .config/, invisible until linked.
RUN bun install --cwd .config --frozen-lockfile \
    && bash .tools/automation/bootstrap/link-node-modules.sh

ENV WORK_DIR=/tmp/carbon-cloud-worker
CMD ["bun", "products/carbon-cloud/composition/worker-linux.ts"]
