// HTTP API surface for carbon-registry. Handles plugin search,
// package publishing, metadata queries, and tarball downloads.

import { type VerifiedToken } from "@carbon/identity";
import { type PublishRequest, type RegistryEnginePort } from "../services/RegistryEngine.ts";

export interface RegistryRouteDeps {
  readonly verifyToken: { execute(token: string): Promise<VerifiedToken | null> };
  readonly registryEngine: RegistryEnginePort;
}

export function buildRegistryRoutes(deps: RegistryRouteDeps) {
  const engine = deps.registryEngine;

  async function authenticate(req: Request): Promise<VerifiedToken> {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new Error("Missing or malformed Authorization header. Expected 'Bearer cc_...'");
    }
    const token = authHeader.slice("Bearer ".length).trim();
    const verified = await deps.verifyToken.execute(token);
    if (!verified) {
      throw new Error("Invalid or expired token");
    }
    return verified;
  }

  function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    return Response.json(data, {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        ...extraHeaders,
      },
    });
  }

  return async function handleRegistryRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      return json({}, 204);
    }

    try {
      // 1. Health check
      if (path === "/api/v1/health" && method === "GET") {
        return json({
          status: "healthy",
          service: "carbon-registry",
          timestamp: new Date().toISOString(),
        });
      }

      // 2. Stats
      if (path === "/api/v1/stats" && method === "GET") {
        return json(await engine.getStats());
      }

      // 3. Categories
      if (path === "/api/v1/categories" && method === "GET") {
        return json((await engine.getStats()).categories);
      }

      // 4. List / Search Plugins: GET /api/v1/plugins
      if (path === "/api/v1/plugins" && method === "GET") {
        const category = url.searchParams.get("category") || undefined;
        const search = url.searchParams.get("search") || url.searchParams.get("q") || undefined;
        const platform = url.searchParams.get("platform") || undefined;
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined;

        const result = await engine.listPlugins({ category, search, platform, limit, offset });
        return json(result);
      }

      // 5. Plugin Details: GET /api/v1/plugins/:name
      const detailMatch = path.match(/^\/api\/v1\/plugins\/([^/]+)$/);
      if (detailMatch && method === "GET") {
        const name = detailMatch[1];
        const plugin = await engine.getPlugin(name);
        if (!plugin) {
          return json({ error: `Plugin "${name}" not found` }, 404);
        }
        return json(plugin);
      }

      // 6. Download Tarball: GET /api/v1/plugins/:name/:version/download or /api/v1/plugins/:name/download
      const downloadMatch = path.match(/^\/api\/v1\/plugins\/([^/]+)(?:\/([^/]+))?\/download$/);
      if (downloadMatch && method === "GET") {
        const name = downloadMatch[1];
        const version = downloadMatch[2]; // optional
        try {
          const result = await engine.download(name, version);
          return json(result);
        } catch (err: any) {
          return json({ error: err.message || "Not found" }, 404);
        }
      }

      // 7. Publish Plugin: POST /api/v1/publish
      if (path === "/api/v1/publish" && method === "POST") {
        const verified = await authenticate(req);
        const body = (await req.json()) as {
          manifest: any;
          readme?: string;
          tarballBase64: string;
          authorName?: string;
          tags?: string[];
        };

        if (!body.manifest || !body.tarballBase64) {
          return json({ error: "Missing required fields: manifest and tarballBase64 are mandatory" }, 400);
        }

        const publishReq: PublishRequest = {
          manifest: body.manifest,
          readme: body.readme,
          tarballBase64: body.tarballBase64,
          authorOrgId: verified.orgId,
          authorName: body.authorName || `Org-${verified.orgId.slice(0, 8)}`,
          tags: body.tags,
        };

        const result = await engine.publish(publishReq);
        return json({ success: true, name: result.name, version: result.version, checksum: result.checksum }, 201);
      }

      return json({ error: `Not found: ${method} ${path}` }, 404);
    } catch (err: any) {
      return json({ error: err.message || "Internal server error" }, 400);
    }
  };
}
