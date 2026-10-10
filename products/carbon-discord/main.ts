#!/usr/bin/env bun
// carbon-discord: the composition root. Builds the client and logs in;
// nothing else. See composition/entrypoint.ts for the wiring.

import type { Client } from "discord.js";
import { configFromEnv, startBot } from "./composition/entrypoint.ts";
import { closeDatabase } from "./infrastructure/state/database.ts";
import { startHealthServer } from "./infrastructure/runtime/health-server.ts";

const config = configFromEnv();
const health = startHealthServer({
  hostname: process.env.HEALTH_HOST?.trim() || "0.0.0.0",
  port: Number(process.env.HEALTH_PORT ?? 3_000),
  guildId: config.guildId,
});

let client: Client | undefined;
let shuttingDown = false;
let watchdog: ReturnType<typeof setInterval> | undefined;

async function shutdown(exitCode: number, reason: string): Promise<never> {
  if (shuttingDown) await new Promise<never>(() => {});
  shuttingDown = true;
  health.markStopping();
  console.log(`shutting down carbon-discord: ${reason}`);
  try {
    if (watchdog) clearInterval(watchdog);
    client?.destroy();
    closeDatabase();
    await health.stop();
  } catch (error) {
    console.error("graceful shutdown failed:", error);
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.once("SIGTERM", () => void shutdown(0, "SIGTERM"));
process.once("SIGINT", () => void shutdown(0, "SIGINT"));
process.once("uncaughtException", (error) => {
  console.error("uncaught exception:", error);
  void shutdown(1, "uncaught exception");
});
process.once("unhandledRejection", (error) => {
  console.error("unhandled rejection:", error);
  void shutdown(1, "unhandled rejection");
});

try {
  client = await startBot(config);
  health.markReady(client);
  const maximumUnreadyMs = Number(process.env.DISCORD_UNREADY_RESTART_SECONDS ?? 300) * 1_000;
  let unreadySince: number | undefined;
  watchdog = setInterval(() => {
    const available = client?.isReady() === true && client.guilds.cache.has(config.guildId);
    if (available) {
      unreadySince = undefined;
      return;
    }
    unreadySince ??= Date.now();
    if (Date.now() - unreadySince >= maximumUnreadyMs) {
      console.error(`Discord remained unavailable for ${maximumUnreadyMs / 1_000} seconds; requesting a clean restart`);
      void shutdown(1, "Discord gateway watchdog");
    }
  }, 10_000);
  console.log(`carbon-discord is ready for guild ${config.guildId}`);
} catch (error) {
  console.error("carbon-discord startup failed:", error);
  await shutdown(1, "startup failure");
}
