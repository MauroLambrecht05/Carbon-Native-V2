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
#
# The libxkbcommon/wayland/x11/mesa/alsa set below is copied from
# .github/workflows/ci.yml, not guessed: carbon-mini's windowing (tao) and
# audio (cpal) dependencies need real system dev packages to compile at all,
# and building this image for real against a real app is what surfaced that
# — cargo failed deep in a transitive dependency's build.rs
# (wayland-sys) with "pkg-config could not be found", the kind of error
# that's easy to under-scope a fix for without seeing it happen.
#
# libgtk-3-dev is NOT in ci.yml's list — added after that fix still left
# gobject-sys/glib-sys failing the same way. CI's cargo build apparently
# never enables whatever capability (native dialogs, clipboard, tray — all
# GTK-backed on Linux) pulls those crates in; a real app with
# `--features dialog` (or similar) does. libgtk-3-dev pulls in
# glib/gobject/gdk/pango/cairo/atk as its own dependencies, which is more
# than strictly needed but is the standard Tauri-class Linux prerequisite
# for exactly this dependency shape, and this repo's os/ adapters are
# Tauri-inspired in the same way.
#
# libdbus-1-dev: notify-rust's "dbus" feature (solutions/infrastructure/os/
# Cargo.toml — switched from "zbus" after a real version-drift build break)
# links against libdbus-1 at build time.
#
# libx11-xcb-dev: softbuffer's "x11" feature (products/carbon/Cargo.toml —
# enabled after "default-features = false" with nothing re-added left its
# dispatch macro with zero backends and 25 compile errors) pulls in
# tiny-xlib, whose build.rs pkg-config-checks for x11-xcb specifically —
# libxrandr-dev/libxi-dev above don't provide that .pc file.

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
        libxkbcommon-dev libwayland-dev libxrandr-dev libxi-dev \
        libgl1-mesa-dev libasound2-dev pkg-config libgtk-3-dev libdbus-1-dev \
        libx11-xcb-dev \
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
