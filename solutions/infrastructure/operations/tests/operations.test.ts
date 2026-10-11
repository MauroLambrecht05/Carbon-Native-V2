import { describe, expect, test } from "bun:test";
import { Metrics, observe, operationsRoutes, readiness, redact, routeOf, type OperationsConfig } from "../index.ts";

const token = (prefix: string, length = 43) => `${prefix}_${"aB3-".repeat(11).slice(0, length)}`;

describe("redaction", () => {
  test("anything shaped like a credential is removed, wherever it sits in the text", () => {
    const secrets = [token("ac"), token("as"), token("csrf"), token("dc"), token("ce"), token("cs"), token("pt"), token("wc"), token("wl"), token("we"), token("op"), token("ru"), token("inv"), token("ec"), token("bt"), token("cr", 22), token("cc"), token("wk"),
      // Provider-shaped examples are assembled here so that no file in the repository contains one whole.
      ["sk", "live", "51NabcDEFghiJKL"].join("_"), ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"), ["whsec", "9f8a7b6c5d4e3f2a"].join("_"), ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"), ["github", "pat", "11ABCDEFG0abcdefghijkl", "mnopqrstuvwxyz"].join("_"), ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
      "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU"];
    for (const secret of secrets) {
      const text = redact(`upstream said: token ${secret} was refused (retry)`);
      expect([secret, text.includes(secret)]).toEqual([secret, false]); expect(text).toBe("upstream said: token [redacted] was refused (retry)");
    }
    // Headers and connection strings keep their shape and lose their secret.
    expect(redact("authorization: Bearer abc.def-ghi_123456")).toBe("authorization: Bearer [redacted]"); expect(redact("Basic dXNlcjpwYXNzd29yZA==")).toBe("Basic [redacted]");
    expect(redact("could not connect to postgres://carbon:s3cr3t-p4ss@db.internal:5432/cloud")).toBe("could not connect to postgres://carbon:[redacted]@db.internal:5432/cloud");
    expect(redact("key:\n-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA\n-----END PRIVATE KEY-----\nend")).toBe("key:\n[redacted]\nend");
    expect(redact(`${token("ac")} and ${token("wl")}`)).toBe("[redacted] and [redacted]");
  });

  test("ordinary text is left exactly as it was", () => {
    for (const text of ["", "relation \"organizations\" does not exist", "duplicate key value violates unique constraint \"functions_environment_id_name_key\"", "timeout after 20000ms connecting to https://registry.example.test/registry/v1/trust",
      "request 6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f failed", "op_ac is not a token", "the as_is clause", "ce_short", "price is sk_live", "see docs/account-authentication.md"]) expect(redact(text)).toBe(text);
  });

  test("a route names the endpoint and carries nothing a customer or a credential put in the URL", () => {
    const id = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
    expect(routeOf(`/platform/v1/orgs/${id}/projects/${id}/environments/${id}/functions/${id}/invoke`)).toBe("/platform/v1/orgs/:id/projects/:id/environments/:id/functions/:id/invoke");
    expect(routeOf(`/internal/platform/v1/environments/${id}/data/rows.query?orgId=${id}&bindingId=${id}`)).toBe("/internal/platform/v1/environments/:id/data/rows.query");
    expect(routeOf(`/internal/platform/v1/environments/${id}/registry/version.submit`)).toBe("/internal/platform/v1/environments/:id/registry/version.submit");
    // Tokens in paths, and names customers chose, are values.
    expect(routeOf(`/registry/v1/uploads/${token("ru")}`)).toBe("/registry/v1/uploads/:value"); expect(routeOf(`/storage/v1/transfers/${token("bt")}`)).toBe("/storage/v1/transfers/:value");
    expect(routeOf(`/platform/v1/exports/download/${token("xd")}`)).toBe("/platform/v1/exports/download/:value");
    expect(routeOf("/registry/v1/packages/acme/clipboard/1.2.0/x86_64-pc-windows-msvc")).toBe("/registry/v1/packages/:value/:value/:value/:value");
    expect(routeOf("/updates/v1/acme-desktop/stable/manifest.json")).toBe("/updates/v1/:value/:value/manifest.json");
    expect(routeOf(`/storage/v1/public/${id}/avatars/people/ada.png`)).toBe("/storage/v1/public/:id/:value/:value/:value");
    // A file name or a dotted word is only kept where the API puts one.
    expect(routeOf(`/storage/v1/public/${id}/reports/salaries.json`)).toBe("/storage/v1/public/:id/:value/:value"); expect(routeOf(`/storage/v1/public/${id}/bucket/rows.query`)).toBe("/storage/v1/public/:id/:value/:value");
    expect(routeOf("/readyz")).toBe("/readyz"); expect(routeOf("/")).toBe("/"); expect(routeOf("/Platform/V1/ORGS")).toBe("/:value/:value/:value");
    expect(routeOf("/platform/v1/auth/complete?token=" + token("ac"))).toBe("/platform/v1/auth/complete");
    // However long or strange the path, the name is bounded.
    expect(routeOf("/" + Array.from({ length: 50 }, (_, index) => `segment${index}`).join("/")).split("/").length).toBe(13);
  });
});

describe("metrics", () => {
  test("counters and histograms are written in the Prometheus text format", () => {
    const metrics = new Metrics();
    metrics.count("carbon_http_requests_total", "Requests handled.", { route: "/readyz", status: "200" }); metrics.count("carbon_http_requests_total", "Requests handled.", { status: "200", route: "/readyz" }); metrics.count("carbon_http_requests_total", "Requests handled.", { route: "/x", status: "500" }, 3);
    metrics.time("carbon_http_request_duration_seconds", "Time to answer.", { route: "/readyz" }, 0.02); metrics.time("carbon_http_request_duration_seconds", "Time to answer.", { route: "/readyz" }, 4);
    const text = metrics.render([{ name: "carbon_builds_open", help: "Open builds.", type: "gauge", labels: { state: "queued" }, value: 2 }, { name: "carbon_builds_open", help: "Open builds.", type: "gauge", labels: { state: "running" }, value: 1 },
      { name: "bad name", help: "x", type: "gauge", value: 1 }, { name: "carbon_nan", help: "x", type: "gauge", value: Number.NaN }]);
    // Label order does not make a new series.
    expect(text).toContain('# HELP carbon_http_requests_total Requests handled.\n# TYPE carbon_http_requests_total counter\ncarbon_http_requests_total{route="/readyz",status="200"} 2\ncarbon_http_requests_total{route="/x",status="500"} 3\n');
    // Buckets are cumulative, and the last one is everything.
    expect(text).toContain('carbon_http_request_duration_seconds_bucket{le="0.01",route="/readyz"} 0\n'); expect(text).toContain('carbon_http_request_duration_seconds_bucket{le="0.025",route="/readyz"} 1\n');
    expect(text).toContain('carbon_http_request_duration_seconds_bucket{le="5",route="/readyz"} 2\n'); expect(text).toContain('carbon_http_request_duration_seconds_bucket{le="+Inf",route="/readyz"} 2\n');
    expect(text).toContain('carbon_http_request_duration_seconds_sum{route="/readyz"} 4.02\n'); expect(text).toContain('carbon_http_request_duration_seconds_count{route="/readyz"} 2\n');
    expect(text).toContain('# HELP carbon_builds_open Open builds.\n# TYPE carbon_builds_open gauge\ncarbon_builds_open{state="queued"} 2\ncarbon_builds_open{state="running"} 1\n');
    expect(text).not.toContain("bad name"); expect(text).not.toContain("carbon_nan"); expect(text.endsWith("\n")).toBe(true);
    // A label value cannot break out of its quotes.
    const escaped = new Metrics(); escaped.count("carbon_x_total", "X.", { route: 'a"b\\c\nd' }); expect(escaped.render()).toContain('carbon_x_total{route="a\\"b\\\\c\\nd"} 1');
  });

  test("label values cannot grow a metric without bound", () => {
    const metrics = new Metrics(); for (let index = 0; index < 5000; index++) metrics.count("carbon_x_total", "X.", { route: `/r${index}` });
    const lines = metrics.render().split("\n").filter(line => line.startsWith("carbon_x_total{"));
    expect(lines.length).toBe(2000); expect(lines).toContain('carbon_x_total{route="other"} 3001');
  });
});

describe("readiness and the operator endpoints", () => {
  const config = (extra: Partial<OperationsConfig> = {}): OperationsConfig & { lines: unknown[] } => { const lines: unknown[] = []; return { service: "carbon-test", metrics: new Metrics(), log: line => { lines.push(line); }, lines, ...extra }; };
  const get = (path: string, headers: Record<string, string> = {}, method = "GET") => new Request(`https://cloud.example.test${path}`, { method, headers });

  test("ready means every check passes; a failing or hanging check is named, and nothing about why is disclosed", async () => {
    expect(await readiness({})).toEqual({ ready: true, checks: {} });
    const result = await readiness({ database: async () => {}, migrations: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"); }, storage: () => new Promise(() => {}) }, 30);
    expect(result).toEqual({ ready: false, checks: { database: "ok", migrations: "failed", storage: "failed" } }); expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  });

  test("healthz says the process is up, readyz says it can work, metrics need the scrape token", async () => {
    let healthy = true; const scrape = "scrape-token-with-enough-length-0123";
    const cfg = config({ metricsToken: scrape, checks: { database: async () => { if (!healthy) throw new Error("down"); } }, collect: [async () => [{ name: "carbon_queue_depth", help: "Depth.", type: "gauge", value: 7 }], async () => { throw new Error("collector failed"); }] });
    const routes = operationsRoutes(cfg);
    expect(await routes(get("/platform/v1/orgs"))).toBeUndefined(); expect(await routes(get("/metricsx"))).toBeUndefined();
    expect(await (await routes(get("/healthz")))!.text()).toBe("ok");
    expect((await routes(get("/readyz")))!.status).toBe(200); healthy = false;
    const unready = (await routes(get("/readyz")))!; expect(unready.status).toBe(503); expect(await unready.json()).toEqual({ ready: false, checks: { database: "failed" } });
    // A dependency being down does not make the process look dead.
    expect((await routes(get("/healthz")))!.status).toBe(200);
    // Without the token, with a wrong one, or with one of another length, the endpoint looks like it is not there.
    for (const headers of [{}, { authorization: "Bearer wrong-token-with-enough-length-0123" }, { authorization: `Bearer ${scrape}x` }, { authorization: scrape }, { authorization: `bearer ${scrape}` }] as Record<string, string>[]) expect((await routes(get("/metrics", headers)))!.status).toBe(404);
    const scraped = (await routes(get("/metrics", { authorization: `Bearer ${scrape}` })))!; expect(scraped.status).toBe(200); expect(scraped.headers.get("content-type")).toContain("text/plain");
    const text = await scraped.text(); expect(text).toContain("carbon_queue_depth 7"); expect(text).toContain('carbon_metrics_collect_failures_total{service="carbon-test"} 1');
    expect((await routes(get("/readyz", {}, "POST")))!.status).toBe(404);
    // No token configured: no metrics endpoint. A token too short to be a secret is refused at start-up.
    expect((await operationsRoutes(config())(get("/metrics", { authorization: `Bearer ${scrape}` })))!.status).toBe(404); expect(() => operationsRoutes(config({ metricsToken: "short" }))).toThrow();
  });

  test("each request leaves one log line and one set of measurements, with no path, query, header, body or address in them", async () => {
    const id = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f"; let clock = 1000; const cfg = config({ now: () => clock });
    const handler = observe(cfg, async (request: Request, peer: string) => {
      clock += 250; const path = new URL(request.url).pathname;
      if (path.endsWith("/boom")) throw new Error(`upstream rejected Bearer abc.def.ghi-123456 for postgres://cloud:pw@db/cloud`);
      return new Response(JSON.stringify({ peer }), { status: path.endsWith("/denied") ? 403 : path.endsWith("/signin") ? 401 : 200, headers: { "x-request-id": "11111111-2222-4333-8444-555555555555" } });
    });
    const secret = token("ac");
    const ok = await handler(new Request(`https://cloud.example.test/platform/v1/orgs/${id}/billing?token=${secret}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, cookie: `__Host-carbon-session=${secret}` }, body: JSON.stringify({ password: secret }) }), "203.0.113.9");
    // The handler's answer comes back untouched, extra arguments and all.
    expect(await ok.json()).toEqual({ peer: "203.0.113.9" });
    expect(cfg.lines).toHaveLength(1);
    expect(cfg.lines[0]).toMatchObject({ event: "http.request", service: "carbon-test", requestId: "11111111-2222-4333-8444-555555555555", method: "POST", route: "/platform/v1/orgs/:id/billing", status: 200, durationMs: 250 });
    expect(Object.keys(cfg.lines[0] as object).sort()).toEqual(["durationMs", "event", "method", "requestId", "route", "service", "status", "time"]);
    await handler(new Request(`https://cloud.example.test/platform/v1/orgs/${id}/denied`), "p"); await handler(new Request("https://cloud.example.test/platform/v1/account/signin"), "p");
    // A handler that throws is answered plainly and logged by route, with what it said made safe.
    // A method outside the usual ones is counted as one name, so a caller cannot invent label values.
    const failed = await handler({ url: `https://cloud.example.test/platform/v1/orgs/${id}/boom`, method: "BREW-COFFEE" } as Request, "p"); expect(failed.status).toBe(500); expect(await failed.text()).not.toContain("upstream");
    const failure = cfg.lines.find(line => (line as { event: string }).event === "http.failure") as { message: string; route: string }; expect(failure.route).toBe("/platform/v1/orgs/:id/:value"); expect(failure.message).toBe("upstream rejected Bearer [redacted] for postgres://cloud:[redacted]@db/cloud");
    const everything = JSON.stringify(cfg.lines) + cfg.metrics.render();
    for (const leaked of [secret, id, "203.0.113.9", "password", "cookie", "pw@db"]) expect([leaked, everything.includes(leaked)]).toEqual([leaked, false]);
    const text = cfg.metrics.render();
    expect(text).toContain('carbon_http_requests_total{method="POST",route="/platform/v1/orgs/:id/billing",service="carbon-test",status="200"} 1');
    expect(text).toContain('carbon_http_requests_total{method="OTHER",route="/platform/v1/orgs/:id/:value",service="carbon-test",status="500"} 1');
    // Refusals are counted on their own.
    expect(text).toContain('carbon_http_denied_total{route="/platform/v1/orgs/:id/:value",service="carbon-test",status="403"} 1'); expect(text).toContain('carbon_http_denied_total{route="/platform/v1/account/:value",service="carbon-test",status="401"} 1');
    expect(text).toContain('carbon_http_request_duration_seconds_bucket{le="0.25",method="POST",route="/platform/v1/orgs/:id/billing",service="carbon-test"} 1');
  });
});
