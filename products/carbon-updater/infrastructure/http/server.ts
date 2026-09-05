import type { Server } from "bun";

export interface ServerConfig {
  readonly port: number;
  readonly handler: (req: Request) => Promise<Response>;
}

export function startUpdaterServer(config: ServerConfig): Server {
  return Bun.serve({
    port: config.port,
    fetch(req: Request): Promise<Response> {
      return config.handler(req);
    },
  });
}
