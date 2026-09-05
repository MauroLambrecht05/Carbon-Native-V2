// The HTTP surface, over fakes for both dependencies — carbon-registry
// owns no identity of its own (a real token comes from carbon-cloud, see
// HttpIdentityClient) and RegistryEngine is real Postgres/S3 now (see
// RegistryEngine.ts's own header comment), so this only checks that a
// request maps to the right engine call, auth gates what it should, and
// status codes are right — none of which needs a database to prove. The
// real engine is verified by actually running the docker stack (see this
// product's README).

import { describe, expect, test } from "bun:test";
import type { VerifiedToken } from "@carbon/identity";
import { buildRegistryRoutes } from "../infrastructure/http/routes.ts";
import type { PublishRequest, RegistryEnginePort } from "../infrastructure/services/RegistryEngine.ts";

const VALID_TOKEN = "cc_test_token";
const ORG_ID = "org-test-guild";

function fakeVerifyToken() {
  return {
    execute: async (token: string): Promise<VerifiedToken | null> =>
      token === VALID_TOKEN ? { orgId: ORG_ID, scope: "org" as const } : null,
  };
}

function fakeEngine(): RegistryEnginePort {
  const published: PublishRequest[] = [];
  return {
    async getStats() {
      return { totalPackages: 7, totalDownloads: 42, totalAuthors: 1, categories: ["carbon-desktop"] };
    },
    async listPlugins() {
      return { plugins: [{ name: "clipboard", category: "carbon-desktop" } as any], total: 7 };
    },
    async getPlugin(name: string) {
      if (name !== "clipboard") return undefined;
      return {
        name: "clipboard",
        category: "carbon-desktop",
        description: "Native clipboard",
        authorOrgId: "org-carbon-core",
        authorName: "Carbon Team",
        latestVersion: "1.0.0",
        downloads: 5,
        verified: true,
        tags: ["clipboard"],
        platforms: ["windows-x86_64"],
        createdAt: new Date().toISOString(),
        readme: "# Clipboard",
        versions: {},
      };
    },
    async download(name: string) {
      if (name !== "clipboard") throw new Error(`Plugin "${name}" not found`);
      return { tarballBase64: Buffer.from("bytes").toString("base64"), checksum: "abc123", version: "1.0.0" };
    },
    async publish(req: PublishRequest) {
      published.push(req);
      return { name: req.manifest.name, version: req.manifest.version, checksum: "def456" };
    },
  };
}

function harness() {
  const handler = buildRegistryRoutes({ verifyToken: fakeVerifyToken(), registryEngine: fakeEngine() });
  return handler;
}

describe("Carbon Registry HTTP Routes", () => {
  test("GET /api/v1/health returns healthy", async () => {
    const handler = harness();
    const res = await handler(new Request("http://localhost/api/v1/health"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe("healthy");
    expect(data.service).toBe("carbon-registry");
  });

  test("GET /api/v1/stats returns aggregate metrics from the engine", async () => {
    const handler = harness();
    const res = await handler(new Request("http://localhost/api/v1/stats"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.totalPackages).toBe(7);
    expect(data.totalDownloads).toBe(42);
  });

  test("GET /api/v1/plugins returns the engine's catalog", async () => {
    const handler = harness();
    const res = await handler(new Request("http://localhost/api/v1/plugins"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.total).toBe(7);
  });

  test("GET /api/v1/plugins/:name 404s for an unknown plugin", async () => {
    const handler = harness();
    const res = await handler(new Request("http://localhost/api/v1/plugins/does-not-exist"));
    expect(res.status).toBe(404);
  });

  test("GET /api/v1/plugins/:name/download 404s for an unknown plugin", async () => {
    const handler = harness();
    const res = await handler(new Request("http://localhost/api/v1/plugins/does-not-exist/download"));
    expect(res.status).toBe(404);
  });

  test("POST /api/v1/publish publishes with a valid carbon-cloud token", async () => {
    const handler = harness();
    const res = await handler(
      new Request("http://localhost/api/v1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify({
          manifest: {
            name: "webrtc-streamer",
            version: "1.0.0",
            category: "carbon-media",
            description: "Zero-latency WebRTC P2P stream plugin",
          },
          tarballBase64: Buffer.from("my-awesome-plugin").toString("base64"),
        }),
      }),
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(data.name).toBe("webrtc-streamer");
  });

  test("POST /api/v1/publish rejects a missing Authorization header", async () => {
    const handler = harness();
    const res = await handler(
      new Request("http://localhost/api/v1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/publish rejects an invalid token", async () => {
    const handler = harness();
    const res = await handler(
      new Request("http://localhost/api/v1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" },
        body: JSON.stringify({
          manifest: { name: "x", version: "1.0.0", category: "carbon-dev", description: "x" },
          tarballBase64: "abc",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
