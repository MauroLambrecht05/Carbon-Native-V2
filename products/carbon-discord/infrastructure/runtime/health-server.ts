import type { Client } from "discord.js";

export type RuntimePhase = "starting" | "ready" | "stopping";

export interface HealthSnapshot {
  readonly phase: RuntimePhase;
  readonly discordReady: boolean;
  readonly guildAvailable: boolean;
  readonly uptimeSeconds: number;
}

export function healthResponse(pathname: string, snapshot: HealthSnapshot): Response {
  const live = snapshot.phase !== "stopping";
  const ready = snapshot.phase === "ready" && snapshot.discordReady && snapshot.guildAvailable;
  const status = pathname === "/health/live" ? live : pathname === "/health/ready" ? ready : undefined;
  if (status === undefined) return new Response("Not found\n", { status: 404 });
  return Response.json({ status: status ? "ok" : "unavailable", ...snapshot }, { status: status ? 200 : 503 });
}

export interface HealthServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly guildId: string;
}

export interface HealthServer {
  markReady(client: Client): void;
  markStopping(): void;
  stop(): Promise<void>;
}

export function startHealthServer(options: HealthServerOptions): HealthServer {
  const startedAt = Date.now();
  let phase: RuntimePhase = "starting";
  let client: Client | undefined;

  const snapshot = (): HealthSnapshot => ({
    phase,
    discordReady: client?.isReady() ?? false,
    guildAvailable: client?.guilds.cache.has(options.guildId) ?? false,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
  });

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch(request) {
      return healthResponse(new URL(request.url).pathname, snapshot());
    },
  });
  console.log(`health server listening on ${options.hostname}:${server.port}`);

  return {
    markReady(readyClient) {
      client = readyClient;
      phase = "ready";
    },
    markStopping() {
      phase = "stopping";
    },
    async stop() {
      await server.stop(true);
    },
  };
}
