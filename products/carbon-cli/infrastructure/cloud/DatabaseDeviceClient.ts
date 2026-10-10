import { createHash, randomUUID } from "node:crypto";
import { canonicalDataRequest, dataPermission, dataRequestPath, parseComponent, type DataRequest, type DataResponse } from "@carbon/contracts/platform";
import type { DeviceProfile } from "./DeviceCredentialStore.ts";
import type { HttpTransport } from "./DeviceAuthorizationClient.ts";

function origin(value: string, label: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error(`${label} URL must be an HTTPS or loopback origin`);
  }
  return url.origin;
}

async function boundedJson(response: Response, requestId: string): Promise<unknown> {
  if (response.redirected || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
    || response.headers.get("x-request-id") !== requestId) throw new Error("A platform service returned an invalid response");
  const reader = response.body?.getReader(); if (!reader) throw new Error("A platform service returned an empty response");
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > 2_179_072) throw new Error("A platform service returned an oversized response"); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof Error && error.message.includes("oversized")) throw error; throw new Error("A platform service returned invalid JSON"); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function sameScope(left: DataRequest["scope"], right: DeviceProfile["grant"]["scope"]): boolean {
  return left.orgId === right.orgId && left.projectId === right.projectId && left.environmentId === right.environmentId && !right.realmId;
}

export class DatabaseDeviceClient {
  constructor(private readonly transport: HttpTransport = fetch) {}

  async execute(databaseUrl: string, profile: DeviceProfile, deviceToken: string, input: DataRequest): Promise<DataResponse> {
    const cloud = origin(profile.controlPlaneUrl, "Carbon Cloud"); const database = origin(databaseUrl, "Carbon Database");
    if (!/^dc_[A-Za-z0-9_-]{43}$/.test(deviceToken)) throw new Error("The stored device credential is invalid");
    const request = parseComponent("DataRequest", input);
    if (!sameScope(request.scope, profile.grant.scope)) throw new Error("The data request does not match the active device scope");
    const body = canonicalDataRequest(request);
    if (Buffer.byteLength(body) > 393_216) throw new Error("The data request exceeds the size limit");
    const path = dataRequestPath(request.scope, request.bindingId, request.command.kind);
    const requestId = randomUUID();
    const exchange = parseComponent("DeviceAssertionExchange", {
      audience: "carbon-database", scope: request.scope, permission: dataPermission(request.command.kind),
      request: { method: "POST", path, bodyDigest: createHash("sha256").update(body).digest("hex") },
    });
    if (!profile.grant.permissions.includes(exchange.permission)) throw new Error("The active device grant does not include this data permission");
    const assertionResponse = await this.transport(`${cloud}/platform/v1/device/assertions`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify(exchange),
    }).catch(() => { throw new Error("Carbon Cloud could not be reached"); });
    if (assertionResponse.status !== 200) { await assertionResponse.body?.cancel(); throw new Error(assertionResponse.status === 401 ? "The device credential is invalid or revoked" : assertionResponse.status === 403 ? "The device credential cannot perform this request" : "Carbon Cloud could not issue a Database assertion"); }
    const assertion = parseComponent("DeviceAssertionResponse", await boundedJson(assertionResponse, requestId));
    const headers: Record<string, string> = { authorization: `Bearer ${assertion.token}`, "content-type": "application/json", "x-request-id": requestId };
    if ("commandId" in request.command) headers["idempotency-key"] = request.command.commandId;
    const response = await this.transport(database + path, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers, body })
      .catch(() => { throw new Error("Carbon Database could not be reached"); });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(response.status === 401 ? "Carbon Database rejected the assertion" : response.status === 403 ? "Carbon Database denied the request" : response.status === 409 ? "The data command conflicts with current state" : "Carbon Database could not complete the request"); }
    const result = parseComponent("DataResponse", await boundedJson(response, requestId));
    if (result.bindingId !== request.bindingId || !sameScope(request.scope, result.scope)) throw new Error("Carbon Database returned a mismatched scope");
    return result;
  }
}
