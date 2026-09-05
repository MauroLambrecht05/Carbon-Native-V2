// HTTP / IPC surface for the local Carbon Updater daemon.

import { PartitionManager } from "../services/PartitionManager.ts";
import { UpdateChecker, type CheckUpdateOptions } from "../services/UpdateChecker.ts";

export interface UpdaterRouteDeps {
  readonly partitionManager: PartitionManager;
  readonly updateChecker?: UpdateChecker;
}

export function buildUpdaterRoutes(deps: UpdaterRouteDeps) {
  const checker = deps.updateChecker || UpdateChecker.getInstance();
  const partitions = deps.partitionManager;

  function json(data: unknown, status = 200): Response {
    return Response.json(data, {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  return async function handleUpdaterRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") return json({}, 204);

    try {
      // 1. Status
      if (path === "/api/v1/updater/status" && method === "GET") {
        return json({
          status: "online",
          partitions: partitions.getState(),
        });
      }

      // 2. Check for updates
      if (path === "/api/v1/updater/check" && method === "POST") {
        const body = (await req.json()) as Partial<CheckUpdateOptions>;
        const currentState = partitions.getState();

        const opts: CheckUpdateOptions = {
          currentVersion: body.currentVersion || currentState.active_slot,
          targetPlatform: body.targetPlatform || "windows-x86_64",
          installationId: body.installationId || currentState.installation_id,
          manifestUrl: body.manifestUrl || "https://releases.carbon.dev/manifest.json",
          trustedPublicKey: body.trustedPublicKey || "MCowBQYDK2VwAyEA...",
          stopListUrl: body.stopListUrl,
          mockManifestJson: body.mockManifestJson,
          mockManifestSig: body.mockManifestSig,
          mockStopList: body.mockStopList,
        };

        const result = await checker.checkUpdate(opts);
        return json(result);
      }

      // 3. Promote slot
      if (path === "/api/v1/updater/promote" && method === "POST") {
        const body = (await req.json()) as { version: string };
        if (!body.version) return json({ error: "Missing version parameter" }, 400);

        partitions.promoteSlot(body.version);
        return json({
          success: true,
          partitions: partitions.getState(),
        });
      }

      // 4. Report crash
      if (path === "/api/v1/updater/report-crash" && method === "POST") {
        const res = partitions.reportAppLaunch();
        return json(res);
      }

      // 5. Report success
      if (path === "/api/v1/updater/report-success" && method === "POST") {
        partitions.reportAppSuccess();
        return json({ success: true, in_progress_count: 0 });
      }

      // 6. Force rollback
      if (path === "/api/v1/updater/rollback" && method === "POST") {
        const res = partitions.forceRollback();
        return json({ success: true, ...res, partitions: partitions.getState() });
      }

      return json({ error: `Not found: ${method} ${path}` }, 404);
    } catch (err: any) {
      return json({ error: err.message || "Internal server error" }, 400);
    }
  };
}
