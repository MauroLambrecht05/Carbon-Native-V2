import { expect, test } from "bun:test";
import { PlatformFault } from "@carbon/contracts/platform";
import { RateLimiter } from "@carbon/operations";
import type { WorkerProtocol } from "@carbon/catalog";
import { createWorkerRoutes } from "../infrastructure/http/worker-routes.ts";
import { workerRateLimitFromEnv } from "../composition/account-platform.ts";

const origin = "https://cloud.example.test";
// Stands in for the worker protocol: it knows one credential and refuses every other.
const known = `Bearer wc_${"A".repeat(43)}`; let claims = 0;
const workers = { claim: async (authorization: string) => { claims++; if (authorization !== known) throw new PlatformFault("unauthenticated", "Invalid worker credential"); return { state: "idle" }; } } as unknown as WorkerProtocol;
const claim = (handler: ReturnType<typeof createWorkerRoutes>, authorization: string | null, peer = "203.0.113.20") =>
  handler(new Request(`${origin}/worker/v1/leases/claim`, { method: "POST", headers: authorization ? { authorization } : {} }), peer);

test("a worker credential over its limit is refused until its window ends, without the protocol being asked", async () => {
  let now = 1_000_000; claims = 0; const handler = createWorkerRoutes(workers, origin, undefined, undefined, new RateLimiter({ limit: 3, windowSeconds: 60 }, () => now));
  for (let index = 0; index < 3; index++) expect((await claim(handler, known)).status).toBe(200);
  const refused = await claim(handler, known); expect(refused.status).toBe(429); expect(refused.headers.get("retry-after")).toBe("60");
  expect(await refused.json()).toMatchObject({ error: { code: "rate_limited", message: "Too many requests from this worker; slow down" } });
  // Refused requests cost nothing further: the protocol, and so the database, is not reached.
  expect(claims).toBe(3); for (let index = 0; index < 20; index++) expect((await claim(handler, known)).status).toBe(429); expect(claims).toBe(3);
  // Another worker is not affected by this one, and neither is a different address presenting no credential.
  const other = `Bearer wc_${"B".repeat(43)}`; expect((await claim(handler, other)).status).toBe(401); expect((await claim(handler, null, "198.51.100.7")).status).toBe(401);
  // Guessing credentials is counted per guess and per address without one, so it cannot be used to lock out a real worker.
  expect((await claim(handler, known)).status).toBe(429);
  now += 60_000; expect((await claim(handler, known)).status).toBe(200); expect(refused.headers.get("cache-control")).toBe("no-store");
});

test("without a limiter nothing is counted, and requests a browser would send are refused before the limiter sees them", async () => {
  claims = 0; const open = createWorkerRoutes(workers, origin);
  for (let index = 0; index < 10; index++) expect((await claim(open, known)).status).toBe(200);
  const limited = createWorkerRoutes(workers, origin, undefined, undefined, new RateLimiter({ limit: 1, windowSeconds: 60 }));
  for (let index = 0; index < 5; index++) expect((await limited(new Request(`${origin}/worker/v1/leases/claim`, { method: "POST", headers: { authorization: known, origin: "https://evil.example.test" } }), "203.0.113.20")).status).toBe(403);
  // None of those counted against the worker.
  expect((await claim(limited, known)).status).toBe(200); expect((await claim(limited, known)).status).toBe(429);
});

test("the limit comes from configuration, with a default and a refusal of nonsense", () => {
  expect(workerRateLimitFromEnv({})).toEqual({ limit: 1200, windowSeconds: 60 }); expect(workerRateLimitFromEnv({ CARBON_WORKER_REQUESTS_PER_MINUTE: "300" })).toEqual({ limit: 300, windowSeconds: 60 });
  for (const value of ["0", "59", "100001", "many", "12.5", "-5"]) expect(() => workerRateLimitFromEnv({ CARBON_WORKER_REQUESTS_PER_MINUTE: value })).toThrow("CARBON_WORKER_REQUESTS_PER_MINUTE");
});
