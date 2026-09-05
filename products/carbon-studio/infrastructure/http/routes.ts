// HTTP API surface for carbon-studio. Provides layout templates
// and dynamic .ctsx code generation endpoints.

import { CodeGenerator, type StudioNode } from "../services/CodeGenerator.ts";

export function buildStudioRoutes() {
  const codeGen = CodeGenerator.getInstance();

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

  return async function handleStudioRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      return json({}, 204);
    }

    try {
      if (path === "/api/v1/health" && method === "GET") {
        return json({ status: "healthy", service: "carbon-studio" });
      }

      if (path === "/api/v1/templates" && method === "GET") {
        return json(codeGen.getTemplates());
      }

      if (path === "/api/v1/generate" && method === "POST") {
        const body = (await req.json()) as { node: StudioNode; appName?: string; targetOs?: any };
        if (!body.node) {
          return json({ error: "Missing node hierarchy in request body" }, 400);
        }

        const code = codeGen.generateCtsx(body.node, {
          appName: body.appName,
          targetOs: body.targetOs,
        });

        return json({ code });
      }

      return json({ error: `Not found: ${method} ${path}` }, 404);
    } catch (err: any) {
      return json({ error: err.message || "Internal server error" }, 400);
    }
  };
}
