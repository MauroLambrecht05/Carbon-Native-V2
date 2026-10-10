import { describe, expect, test } from "bun:test";
import { healthResponse, type HealthSnapshot } from "../../infrastructure/runtime/health-server.ts";

const healthy: HealthSnapshot = {
  phase: "ready",
  discordReady: true,
  guildAvailable: true,
  uptimeSeconds: 42,
};

describe("runtime health responses", () => {
  test("readiness requires Discord and the configured guild", () => {
    expect(healthResponse("/health/ready", healthy).status).toBe(200);
    expect(healthResponse("/health/ready", { ...healthy, discordReady: false }).status).toBe(503);
    expect(healthResponse("/health/ready", { ...healthy, guildAvailable: false }).status).toBe(503);
  });

  test("liveness fails while the process is stopping", () => {
    expect(healthResponse("/health/live", { ...healthy, phase: "stopping" }).status).toBe(503);
    expect(healthResponse("/unknown", healthy).status).toBe(404);
  });
});
