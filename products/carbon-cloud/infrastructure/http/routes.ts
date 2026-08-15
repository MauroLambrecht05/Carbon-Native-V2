// The HTTP surface. Thin on purpose: every handler here does request
// parsing, calls exactly one solutions/capabilities/cloud-orchestration use
// case, and maps the result (or the error it threw) to a Response. No
// business logic lives in this file — that's the rule products/README.md
// states and this product follows deliberately.

import type { InstallerTargetId, TargetPlatform } from "@carbon/contracts/distribution";
import {
  BuildNotFoundError,
  InvalidTransitionError,
  type ClaimNextBuildUseCase,
  type CompleteBuildUseCase,
  type CreateBuildUseCase,
  type GetBuildUseCase,
} from "@carbon/cloud-orchestration";
import type { CreateOrganizationUseCase, VerifyTokenUseCase } from "@carbon/identity";
import type { CheckUsageLimitUseCase, RecordBuildUsageUseCase } from "@carbon/billing";

export interface RouteDeps {
  readonly createBuild: CreateBuildUseCase;
  readonly getBuild: GetBuildUseCase;
  readonly claimNext: ClaimNextBuildUseCase;
  readonly completeBuild: CompleteBuildUseCase;
  readonly createOrganization: CreateOrganizationUseCase;
  readonly verifyToken: VerifyTokenUseCase;
  readonly checkUsageLimit: CheckUsageLimitUseCase;
  readonly recordBuildUsage: RecordBuildUsageUseCase;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof BuildNotFoundError) return json({ error: error.message }, 404);
  if (error instanceof InvalidTransitionError) return json({ error: error.message }, 409);
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, 400);
}

/**
 * The org a request authenticates as, or a 401 Response to send back.
 *
 * Gates access to /v1/builds/*: every caller (carbon-cli, a worker) needs a
 * valid token. What it does NOT do yet is scope a worker's claim/complete
 * calls to one org's builds specifically — any valid token can claim any
 * org's queued work today. Fine for a single self-hosted deployment where
 * you control every worker; a real gap once multiple untrusted tenants
 * share one control plane.
 */
async function authenticate(req: Request, verifyToken: VerifyTokenUseCase): Promise<string | Response> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return json({ error: "missing bearer token" }, 401);

  const orgId = await verifyToken.execute(token);
  if (!orgId) return json({ error: "invalid token" }, 401);
  return orgId;
}

const DASHBOARD_DIR = new URL("../../presentation/dashboard/", import.meta.url);
const DASHBOARD_HTML = await Bun.file(new URL("index.html", DASHBOARD_DIR)).text();

// Bundled once at startup, not per request — the dashboard is React, and a
// build worker doesn't need Vite pulled in for one entry point when Bun's
// own bundler already resolves JSX and node_modules the same way.
const dashboardBuild = await Bun.build({
  entrypoints: [Bun.fileURLToPath(new URL("src/main.tsx", DASHBOARD_DIR))],
  target: "browser",
  minify: true,
});
if (!dashboardBuild.success) {
  throw new AggregateError(dashboardBuild.logs, "failed to build the dashboard bundle");
}
const DASHBOARD_JS = await dashboardBuild.outputs[0]!.text();

/** Bun.serve's `routes` object. The composition root is what calls Bun.serve. */
export function buildRoutes(deps: RouteDeps) {
  return {
    "/healthz": {
      GET: () => new Response("ok"),
    },

    "/": {
      GET: () => new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } }),
    },

    "/dashboard.js": {
      GET: () => new Response(DASHBOARD_JS, { headers: { "content-type": "text/javascript" } }),
    },

    "/v1/orgs": {
      POST: async (req: Bun.BunRequest) => {
        try {
          const body = (await req.json()) as { name: string };
          if (!body.name) return json({ error: "name is required" }, 400);
          const result = await deps.createOrganization.execute(body.name);
          return json(result, 201);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds": {
      POST: async (req: Bun.BunRequest) => {
        const orgId = await authenticate(req, deps.verifyToken);
        if (orgId instanceof Response) return orgId;
        try {
          const usage = await deps.checkUsageLimit.execute(orgId);
          if (!usage.withinLimit) {
            return json(
              { error: `plan's ${usage.includedMinutes} included build-minutes used for this period` },
              402,
            );
          }
          const body = (await req.json()) as {
            repoUrl: string;
            commitSha: string;
            targets: InstallerTargetId[];
          };
          const build = await deps.createBuild.execute({ orgId, ...body });
          return json(build.toProps(), 201);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds/:id": {
      GET: async (req: Bun.BunRequest<"/v1/builds/:id">) => {
        const orgId = await authenticate(req, deps.verifyToken);
        if (orgId instanceof Response) return orgId;
        try {
          const build = await deps.getBuild.execute(req.params.id);
          return json(build.toProps());
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds/claim": {
      POST: async (req: Bun.BunRequest) => {
        const authed = await authenticate(req, deps.verifyToken);
        if (authed instanceof Response) return authed;
        try {
          const body = (await req.json()) as { platform: TargetPlatform; workerId: string };
          const build = await deps.claimNext.execute(body);
          return build ? json(build.toProps()) : json(null, 204);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds/:id/complete": {
      POST: async (req: Bun.BunRequest<"/v1/builds/:id/complete">) => {
        const authed = await authenticate(req, deps.verifyToken);
        if (authed instanceof Response) return authed;
        try {
          const body = (await req.json()) as Record<string, unknown>;
          const buildId = req.params.id;
          await deps.completeBuild.execute({ ...body, buildId } as Parameters<
            CompleteBuildUseCase["execute"]
          >[0]);

          // Metered on wall time from creation to this outcome, not just
          // time spent "running" — queue wait is real cost too, and Build
          // doesn't track a separate started-running timestamp to bill off
          // instead. Only succeeded/failed are terminal; "running" isn't
          // billable yet.
          if (body.outcome === "succeeded" || body.outcome === "failed") {
            const build = (await deps.getBuild.execute(buildId)).toProps();
            await deps.recordBuildUsage.execute({
              orgId: build.orgId,
              buildId,
              durationMs: build.updatedAt.getTime() - build.createdAt.getTime(),
            });
          }

          return json({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  };
}
