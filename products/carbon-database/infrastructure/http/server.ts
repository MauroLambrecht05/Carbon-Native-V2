import type { Server, ServerWebSocket } from "bun";
import { join } from "path";
import { RealtimeEngine, type ClientSocket } from "../services/RealtimeEngine.ts";

export interface ServerConfig {
  readonly port: number;
  readonly handler: (req: Request) => Promise<Response>;
  readonly realtime: RealtimeEngine;
  readonly staticDir?: string;
}

interface WebSocketData {
  readonly id: string;
  clientSocket?: ClientSocket;
}

export function startDatabaseServer(config: ServerConfig): Server<WebSocketData> {
  const staticRoot = config.staticDir || join(import.meta.dir, "../../presentation");
  const realtime = config.realtime;

  const server = Bun.serve<WebSocketData>({
    port: config.port,
    async fetch(req: Request, s: Server<WebSocketData>): Promise<Response> {
      const url = new URL(req.url);

      // Upgrade WebSocket for Realtime CDC feed
      if (url.pathname === "/realtime/v1/websocket") {
        const id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const upgraded = s.upgrade(req, { data: { id } });
        if (upgraded) {
          return undefined as any;
        }
        return new Response("WebSocket Upgrade Failed", { status: 400 });
      }

      // Pass API, PostgREST and storage requests to router
      if (
        url.pathname.startsWith("/api") ||
        url.pathname.startsWith("/rest") ||
        url.pathname.startsWith("/storage")
      ) {
        return await config.handler(req);
      }

      // Serve web studio HTML/assets
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
    websocket: {
      open(ws: ServerWebSocket<WebSocketData>) {
        const clientSocket: ClientSocket = {
          id: ws.data.id,
          send: (msg: string) => ws.send(msg),
        };
        ws.data.clientSocket = clientSocket;
        realtime.handleConnect(clientSocket);
      },
      message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
        try {
          const raw = typeof message === "string" ? message : message.toString();
          const parsed = JSON.parse(raw);

          if (ws.data.clientSocket) {
            if (parsed.type === "subscribe" && parsed.topic) {
              realtime.subscribe(ws.data.clientSocket, parsed.topic);
            } else if (parsed.type === "unsubscribe" && parsed.topic) {
              realtime.unsubscribe(ws.data.clientSocket, parsed.topic);
            }
          }
        } catch {
          // Ignore invalid JSON payloads from clients
        }
      },
      close(ws: ServerWebSocket<WebSocketData>) {
        if (ws.data.clientSocket) {
          realtime.handleDisconnect(ws.data.clientSocket);
        }
      },
    },
  });

  return server;
}
