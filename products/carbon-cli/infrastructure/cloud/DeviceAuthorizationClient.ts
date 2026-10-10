import { randomUUID } from "node:crypto";
import { parseComponent, type DeviceAuthorizationChallenge, type DeviceAuthorizationCreate, type DeviceTokenResponse } from "@carbon/contracts/platform";

export interface DeviceAuthorizationHooks {
  readonly challenge: (challenge: DeviceAuthorizationChallenge) => void | Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export type HttpTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function origin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Carbon Cloud URL must be an HTTPS or loopback origin");
  }
  return url.origin;
}

async function jsonResponse(response: Response, requestId: string): Promise<unknown> {
  if (response.redirected || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
    || response.headers.get("x-request-id") !== requestId) throw new Error("Carbon Cloud returned an invalid response");
  const reader = response.body?.getReader(); if (!reader) throw new Error("Carbon Cloud returned an empty response");
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > 65_536) throw new Error("Carbon Cloud returned an oversized response"); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof Error && error.message.includes("oversized")) throw error; throw new Error("Carbon Cloud returned invalid JSON"); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function safeFailure(status: number): Error {
  return new Error(status === 403 ? "Carbon Cloud rejected this device"
    : status === 429 ? "Carbon Cloud rate limited the device request"
    : status >= 500 ? "Carbon Cloud is unavailable" : "Carbon Cloud rejected the device authorization request");
}

export class DeviceAuthorizationClient {
  constructor(private readonly transport: HttpTransport = fetch) {}

  async authorize(controlPlaneUrl: string, value: DeviceAuthorizationCreate, hooks: DeviceAuthorizationHooks): Promise<Extract<DeviceTokenResponse, { state: "authorized" }>> {
    const base = origin(controlPlaneUrl); const input = parseComponent("DeviceAuthorizationCreate", value);
    const createId = randomUUID();
    const created = await this.transport(`${base}/platform/v1/device/authorizations`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", "x-request-id": createId }, body: JSON.stringify(input),
    }).catch(() => { throw new Error("Carbon Cloud could not be reached"); });
    if (created.status !== 201) { await created.body?.cancel(); throw safeFailure(created.status); }
    const challenge = parseComponent("DeviceAuthorizationChallenge", await jsonResponse(created, createId));
    await hooks.challenge(challenge);
    const wait = hooks.wait ?? (milliseconds => Bun.sleep(milliseconds)); const now = hooks.now ?? Date.now;
    let interval = challenge.intervalSeconds;
    while (now() < new Date(challenge.expiresAt).getTime()) {
      await wait(interval * 1000);
      const requestId = randomUUID();
      const response = await this.transport(`${base}/platform/v1/device/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ deviceCode: challenge.deviceCode }),
      }).catch(() => { throw new Error("Carbon Cloud could not be reached"); });
      if (response.status === 429) { await response.body?.cancel(); continue; }
      if (response.status !== 200) { await response.body?.cancel(); throw safeFailure(response.status); }
      const result = parseComponent("DeviceTokenResponse", await jsonResponse(response, requestId));
      if (result.state === "authorized") return result;
      if (result.state === "pending") { interval = Math.max(interval, result.intervalSeconds); continue; }
      throw new Error(result.state === "denied" ? "Device authorization was denied"
        : result.state === "expired" ? "Device authorization expired" : "Device authorization was already consumed");
    }
    throw new Error("Device authorization expired");
  }
}
