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

export interface RouteDeps {
  readonly createBuild: CreateBuildUseCase;
  readonly getBuild: GetBuildUseCase;
  readonly claimNext: ClaimNextBuildUseCase;
  readonly completeBuild: CompleteBuildUseCase;
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

    "/v1/builds": {
      POST: async (req: Bun.BunRequest) => {
        try {
          const body = (await req.json()) as {
            orgId?: string;
            repoUrl: string;
            commitSha: string;
            targets: InstallerTargetId[];
          };
          const build = await deps.createBuild.execute({
            orgId: body.orgId ?? "default",
            repoUrl: body.repoUrl,
            commitSha: body.commitSha,
            targets: body.targets,
          });
          return json(build.toProps(), 201);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds/:id": {
      GET: async (req: Bun.BunRequest<"/v1/builds/:id">) => {
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
        try {
          const body = (await req.json()) as Record<string, unknown>;
          await deps.completeBuild.execute({ ...body, buildId: req.params.id } as Parameters<
            CompleteBuildUseCase["execute"]
          >[0]);
          return json({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  };
}
