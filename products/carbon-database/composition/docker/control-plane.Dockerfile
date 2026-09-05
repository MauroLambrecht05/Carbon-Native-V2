# carbon-database — control plane / API server.
#
# Bun only: this process never compiles anything (unlike carbon-cloud's
# build workers) — it's a real Postgres-backed API server, real S3-
# compatible object storage, nothing else. Same base image and node_modules
# linking steps as carbon-cloud's own control-plane.Dockerfile, copied
# rather than shared since each hosted product owns its own Dockerfile the
# same way it owns its own persistence.

FROM debian:bookworm-slim

ARG BUN_VERSION=1.3.10
ENV PATH=/usr/local/bun/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s "bun-v${BUN_VERSION}"

WORKDIR /app
COPY . .

RUN bun install --cwd .config --frozen-lockfile \
    && bash .tools/automation/bootstrap/link-node-modules.sh

EXPOSE 54321
CMD ["bun", "products/carbon-database/main.ts"]
