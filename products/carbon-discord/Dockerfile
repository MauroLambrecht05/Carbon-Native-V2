FROM oven/bun:1.3.10-alpine AS dependencies
WORKDIR /app
COPY package.json ./
RUN bun install --production

FROM oven/bun:1.3.10-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HEALTH_HOST=0.0.0.0 \
    HEALTH_PORT=3000 \
    DISCORD_DATA_PATH=/app/data/carbon-discord.sqlite

RUN mkdir -p /app/data && chown -R bun:bun /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json main.ts tsconfig.json ./
COPY --chown=bun:bun composition ./composition
COPY --chown=bun:bun infrastructure ./infrastructure
COPY --chown=bun:bun presentation ./presentation

USER bun
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD ["bun", "run", "healthcheck"]
STOPSIGNAL SIGTERM
CMD ["bun", "run", "start"]
