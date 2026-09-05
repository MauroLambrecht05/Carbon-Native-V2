// Composition root for carbon-updater daemon

import { PartitionManager } from "../infrastructure/services/PartitionManager.ts";
import { UpdateChecker } from "../infrastructure/services/UpdateChecker.ts";
import { buildUpdaterRoutes } from "../infrastructure/http/routes.ts";
import { startUpdaterServer } from "../infrastructure/http/server.ts";

export interface CarbonUpdaterConfig {
  readonly port: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CarbonUpdaterConfig {
  return {
    port: Number(env.PORT || 54324),
  };
}

export function buildUpdaterSystem() {
  const partitionManager = new PartitionManager();
  const updateChecker = UpdateChecker.getInstance();

  const deps = {
    partitionManager,
    updateChecker,
  };

  const handler = buildUpdaterRoutes(deps);
  return { deps, handler };
}

export function startUpdater(config: CarbonUpdaterConfig = configFromEnv()) {
  const { deps, handler } = buildUpdaterSystem();
  const server = startUpdaterServer({
    port: config.port,
    handler,
  });

  console.log(`\n🔄 Carbon Updater Daemon running at: http://localhost:${server.port}`);
  console.log(`🛡️  A/B partition manager, Ed25519 verifier, and 3-strike crash rollback online`);

  return { server, deps };
}

if (import.meta.main) {
  startUpdater();
}
