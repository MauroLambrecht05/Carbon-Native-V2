import type { Server } from "bun";
import { join } from "path";

export interface ServerConfig {
  readonly port: number;
  readonly handler: (req: Request) => Promise<Response>;
  readonly staticDir?: string;
}

export function startRegistryServer(config: ServerConfig): Server<undefined> {
  const staticRoot = config.staticDir || join(import.meta.dir, "../../presentation");

  const server = Bun.serve({
    port: config.port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // Pass API requests to router
      if (url.pathname.startsWith("/api")) {
        return await config.handler(req);
      }

      // Serve web marketplace HTML/assets
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const file = Bun.file(join(staticRoot, "index.html"));
        if (await file.exists()) {
          return new Response(file, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      // Try static file
      const candidate = Bun.file(join(staticRoot, url.pathname));
      if (await candidate.exists()) {
        return new Response(candidate);
      }

      // Default fallback to index.html for SPA client-side routing
      const indexFile = Bun.file(join(staticRoot, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return server;
}
