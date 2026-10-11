import { afterAll, expect, test } from "bun:test";
import { startRegistryServer } from "../infrastructure/http/server.ts";

// The server decides which paths reach the request handler at all. Canonical
// publishing and distribution, and the operator endpoints, were added to the
// handler in later phases; this checks the server actually lets them through.
const server = startRegistryServer({ port: 0, handler: async request => new Response(`handled ${new URL(request.url).pathname}`, { status: 299 }) });
afterAll(() => server.stop(true));
const ask = async (path: string, method = "GET") => { const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, body: method === "GET" ? undefined : "x" }); return [response.status, response.status === 299 ? await response.text() : ""]; };

test("every API family and the operator endpoints reach the handler; everything else is the static site", async () => {
  for (const path of ["/api/v1/plugins", "/internal/platform/v1/environments/x/registry/namespace.get", "/internal/platform/v1/environments/x/lifecycle", "/registry/v1/trust", "/registry/v1/packages/acme/clipboard",
    "/registry/v1/packages/acme/clipboard/1.2.0/x86_64-pc-windows-msvc", "/healthz", "/readyz", "/metrics"]) expect(await ask(path)).toEqual([299, `handled ${path}`]);
  expect(await ask("/registry/v1/uploads/ru_token", "PUT")).toEqual([299, "handled /registry/v1/uploads/ru_token"]);
  // Not an API path: never handed to the handler.
  for (const path of ["/", "/marketplace", "/registryx/v1/trust", "/readyzz"]) expect((await ask(path))[0]).not.toBe(299);
});
