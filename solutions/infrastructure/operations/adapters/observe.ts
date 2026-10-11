// One log line and one set of measurements per request, and the two
// endpoints operators use: `/readyz` and `/metrics`.

import { timingSafeEqual } from "node:crypto";
import { Metrics, type Sample } from "./metrics.ts";
import { readiness, type ReadinessCheck } from "./readiness.ts";
import { redact, routeOf } from "./redaction.ts";

/** What is written for each request. It has no path, query, header, body, address or account: only what a route is called and how it went. */
export interface RequestLog { readonly time: string; readonly event: "http.request"; readonly service: string; readonly requestId: string; readonly method: string; readonly route: string; readonly status: number; readonly durationMs: number }

export interface OperationsConfig {
  readonly service: string;
  readonly metrics: Metrics;
  /** Where a log line goes. One JSON object per line on standard output unless a deployment says otherwise. */
  readonly log?: (line: RequestLog | { time: string; event: "http.failure"; service: string; route: string; message: string }) => void;
  readonly checks?: Readonly<Record<string, ReadinessCheck>>;
  /** Values read when metrics are scraped: queue depths, ages, counts. A collector that fails is left out, not fatal. */
  readonly collect?: readonly (() => Promise<readonly Sample[]>)[];
  /** The bearer token a scraper presents. Without one, `/metrics` does not exist. */
  readonly metricsToken?: string;
  readonly now?: () => number;
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/**
 * Wraps a request handler. The handler's answer is returned untouched; what is added is measurement. A handler
 * that throws is answered with a plain 500 and logged by route, with the error text redacted.
 */
export function observe<Rest extends unknown[]>(config: OperationsConfig, handler: (request: Request, ...rest: Rest) => Response | Promise<Response>): (request: Request, ...rest: Rest) => Promise<Response> {
  const now = config.now ?? (() => performance.now()); const log = config.log ?? (line => console.log(JSON.stringify(line)));
  return async (request, ...rest) => {
    const started = now(); const route = routeOf(new URL(request.url).pathname); const method = METHODS.has(request.method) ? request.method : "OTHER";
    let response: Response;
    try { response = await handler(request, ...rest); }
    catch (error) {
      log({ time: new Date().toISOString(), event: "http.failure", service: config.service, route, message: redact(error instanceof Error ? error.message : "unknown error").slice(0, 500) });
      response = json({ error: { code: "internal", message: "The request could not be completed" } }, 500);
    }
    const seconds = Math.max(0, (now() - started) / 1000); const status = String(response.status); const labels = { service: config.service, route, method, status };
    config.metrics.count("carbon_http_requests_total", "Requests handled, by route and status.", labels);
    config.metrics.time("carbon_http_request_duration_seconds", "Time to answer a request.", { service: config.service, route, method }, seconds);
    // Refusals are counted on their own: a rise in them is how credential stuffing and broken clients first show.
    if (response.status === 401 || response.status === 403) config.metrics.count("carbon_http_denied_total", "Requests refused as unauthenticated or forbidden.", { service: config.service, route, status });
    log({ time: new Date().toISOString(), event: "http.request", service: config.service, requestId: (response.headers.get("x-request-id") ?? "").slice(0, 64), method, route, status: response.status, durationMs: Math.round(seconds * 1000) });
    return response;
  };
}

/**
 * `/healthz`, `/readyz` and `/metrics` for one service. Returns undefined for any other path, so a server can try
 * this first and fall through.
 *
 *   /healthz   the process is up. Checks nothing else, so a dependency outage does not get the process restarted.
 *   /readyz    the process can do its work: every check passes. Answers 503 otherwise, naming the checks that failed.
 *   /metrics   Prometheus text, only to a caller that presents the scrape token.
 */
export function operationsRoutes(config: OperationsConfig): (request: Request) => Promise<Response | undefined> {
  const expected = config.metricsToken ? Buffer.from(`Bearer ${config.metricsToken}`) : undefined;
  if (config.metricsToken !== undefined && config.metricsToken.length < 24) throw new Error("The metrics token must be at least 24 characters");
  return async request => {
    const path = new URL(request.url).pathname;
    if (path !== "/healthz" && path !== "/readyz" && path !== "/metrics") return undefined;
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: { code: "not_found", message: "Not found" } }, 404);
    if (path === "/healthz") return new Response("ok", { headers: { "cache-control": "no-store" } });
    if (path === "/readyz") { const result = await readiness(config.checks ?? {}); return json(result, result.ready ? 200 : 503); }
    // Without a token configured, or with the wrong one, the endpoint looks like it is not there.
    const given = Buffer.from(request.headers.get("authorization") ?? "");
    if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) return json({ error: { code: "not_found", message: "Not found" } }, 404);
    const samples: Sample[] = [];
    for (const collect of config.collect ?? []) { try { samples.push(...await collect()); } catch { config.metrics.count("carbon_metrics_collect_failures_total", "Collectors that could not be read at scrape time.", { service: config.service }); } }
    return new Response(config.metrics.render(samples), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
  };
}
