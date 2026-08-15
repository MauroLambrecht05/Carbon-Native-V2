# Carbon Cloud — control plane.
#
# Bun only: this process never builds an app, it tracks builds and serves
# the API + dashboard. Compare worker-linux.Dockerfile, which needs the
# full Rust + packaging toolchain because it does.

FROM debian:bookworm-slim

ARG BUN_VERSION=1.3.10
ENV PATH=/usr/local/bun/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s "bun-v${BUN_VERSION}"

WORKDIR /app
COPY . .

# The real node_modules lives in .config/ (see .config/package.json's own
# note on why); nothing walks up to find it until this link exists — same
# two steps .tools/automation/bootstrap/link-node-modules.sh documents for
# a dev machine.
RUN bun install --cwd .config --frozen-lockfile \
    && bash .tools/automation/bootstrap/link-node-modules.sh

EXPOSE 8080
CMD ["bun", "products/carbon-cloud/main.ts"]
