// Composition root for carbon-studio: GUI Builder & Playground server

import { buildStudioRoutes } from "../infrastructure/http/routes.ts";
import { startStudioServer } from "../infrastructure/http/server.ts";

export interface CarbonStudioConfig {
  readonly port: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonStudioConfig {
  return {
    port: Number(env.PORT || 54322),
  };
}

export function startStudio(config: CarbonStudioConfig = configFromEnv()) {
  const handler = buildStudioRoutes();
  const server = startStudioServer({
    port: config.port,
    handler,
  });

  console.log(`\n🎨 Carbon Studio running at: http://localhost:${server.port}`);
  console.log(`🖌️  Visual GUI Builder, component inspector, and live .ctsx generator online`);

  return { server, handler };
}

if (import.meta.main) {
  startStudio();
}
