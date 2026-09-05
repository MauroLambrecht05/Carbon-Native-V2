import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startUpdater } from "../composition/entrypoint.ts";
import { CarbonUpdaterClient } from "../presentation/src/client.ts";
import { UpdaterPromptStateMachine } from "../presentation/src/widget.ts";

describe("Carbon Updater Daemon E2E", () => {
  let server: any;
  let client: CarbonUpdaterClient;

  beforeAll(() => {
    const running = startUpdater({ port: 54378 });
    server = running.server;
    client = new CarbonUpdaterClient(`http://localhost:${server.port}`);
  });

  afterAll(() => {
    if (server?.stop) server.stop();
  });

  test("status, check, promote, report success and widget state machine", async () => {
    // 1. Initial status
    const status = await client.getStatus();
    expect(status.status).toBe("online");
    expect(status.partitions.active_slot).toBeDefined();

    // 2. Widget state machine test
    const widget = new UpdaterPromptStateMachine();
    expect(widget.getState().state).toBe("idle");

    widget.onStartChecking();
    expect(widget.getState().state).toBe("checking");

    widget.onUpdateFound("2.1.0");
    expect(widget.getState().state).toBe("update-available");
    expect(widget.getState().newVersion).toBe("2.1.0");

    widget.onStartDownload();
    widget.onProgress(50);
    expect(widget.getState().progressPercent).toBe(50);

    widget.onDownloadComplete();
    expect(widget.getState().state).toBe("ready-to-restart");

    // 3. Promote version via client
    const promRes = await client.promoteVersion("2.1.0");
    expect(promRes.success).toBe(true);
    expect(promRes.partitions.active_slot).toBe("2.1.0");

    // 4. Report health
    const successRes = await client.reportSuccess();
    expect(successRes.success).toBe(true);
  });
});
