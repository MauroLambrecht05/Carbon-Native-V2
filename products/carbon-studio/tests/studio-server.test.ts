import { describe, expect, test } from "bun:test";
import { buildStudioRoutes } from "../infrastructure/http/routes.ts";

describe("Carbon Studio HTTP API", () => {
  const handler = buildStudioRoutes();

  test("GET /api/v1/health returns healthy", async () => {
    const res = await handler(new Request("http://localhost/api/v1/health"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe("healthy");
    expect(data.service).toBe("carbon-studio");
  });

  test("GET /api/v1/templates returns layout templates", async () => {
    const res = await handler(new Request("http://localhost/api/v1/templates"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.blank).toBeDefined();
    expect(data.dashboard).toBeDefined();
  });

  test("POST /api/v1/generate returns generated .ctsx code string", async () => {
    const node = {
      id: "root",
      type: "Window",
      props: { title: "API Window" },
      children: [
        { id: "btn", type: "Button", props: { label: "Test Button" } },
      ],
    };

    const res = await handler(
      new Request("http://localhost/api/v1/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node, appName: "GeneratedApp" }),
      }),
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.code).toContain("export default function GeneratedApp()");
    expect(data.code).toContain('<Button label="Test Button" />');
  });
});
