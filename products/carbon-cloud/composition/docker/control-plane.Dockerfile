# Carbon Cloud — control plane.
#
# Bun only: this process never builds an app, it tracks builds and serves
# the API + dashboard. Compare worker-linux.Dockerfile, which needs the
# full Rust + packaging toolchain because it does.

FROM debian:bookworm-slim

ARG BUN_VERSION=1.3.10
ENV PATH=/usr/local/bun/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s "bun-v${BUN_VERSION}"

WORKDIR /app
COPY . .

EXPOSE 8080
CMD ["bun", "products/carbon-cloud/main.ts"]
