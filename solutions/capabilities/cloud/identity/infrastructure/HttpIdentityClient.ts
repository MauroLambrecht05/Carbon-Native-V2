// A verify-token client for products OTHER than carbon-cloud (which owns
// identity for real, in Postgres) — carbon-database, carbon-registry, and
// any future hosted service accept the SAME bearer token a developer got
// from carbon-cloud's own signup flow by calling this instead of keeping
// a second copy of organizations/api_tokens. One identity, one owner;
// everything else is a client of it over HTTP (carbon-cloud's own
// `GET /v1/auth/verify` route).
//
// Same public shape as VerifyTokenUseCase (`.execute(token) ->
// VerifiedToken | null`) so it's a drop-in replacement wherever a route
// handler's `authenticate()` helper already expects that — no call-site
// changes needed, only what gets constructed in composition.

import type { VerifiedToken } from "../application/usecases/VerifyTokenUseCase.ts";

export class HttpIdentityClient {
  constructor(private readonly controlPlaneUrl: string) {}

  async execute(plaintext: string): Promise<VerifiedToken | null> {
    const res = await fetch(`${this.controlPlaneUrl}/v1/auth/verify`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    // 401 (missing/invalid token) and 403 (wrong scope — never happens
    // here, this endpoint accepts both scopes) both mean "not a usable
    // token" from THIS caller's point of view; anything else (a network
    // error, carbon-cloud down) is left to throw rather than silently
    // treated as "invalid token", so an outage surfaces as a 5xx here,
    // not a misleading 401.
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) {
      throw new Error(`carbon-cloud auth verification failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as VerifiedToken;
  }
}
