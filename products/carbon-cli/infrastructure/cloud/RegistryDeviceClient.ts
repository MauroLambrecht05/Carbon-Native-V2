import { createHash, randomUUID } from "node:crypto";
import { canonicalRegistryRequest, parseComponent, registryPermission, registryRequestPath, type RegistryRequest, type RegistryResponse } from "@carbon/contracts/platform";
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
  const text = await response.text();
  if (text.length > 65_536) throw new Error("A platform service returned an oversized response");
  try { return JSON.parse(text); } catch { throw new Error("A platform service returned invalid JSON"); }
}

/**
 * Calls Carbon Registry with the device credential. The credential never reaches Registry: Cloud exchanges it for a
 * 60-second assertion bound to this exact request, on the Registry-only exchange route.
 */
export class RegistryDeviceClient {
  constructor(private readonly transport: HttpTransport = fetch) {}

  async execute(registryUrl: string, profile: DeviceProfile, deviceToken: string, input: RegistryRequest): Promise<RegistryResponse> {
    const cloud = origin(profile.controlPlaneUrl, "Carbon Cloud"); const registry = origin(registryUrl, "Carbon Registry");
    if (!/^dc_[A-Za-z0-9_-]{43}$/.test(deviceToken)) throw new Error("The stored device credential is invalid");
    const request = parseComponent("RegistryRequest", input); const granted = profile.grant.scope;
    if (request.scope.orgId !== granted.orgId || request.scope.projectId !== granted.projectId || request.scope.environmentId !== granted.environmentId || granted.realmId) {
      throw new Error("The registry request does not match the active device scope");
    }
    const body = canonicalRegistryRequest(request);
    const path = registryRequestPath(request.scope, request.bindingId, request.command.kind);
    const requestId = randomUUID();
    const exchange = parseComponent("DeviceRegistryAssertionExchange", {
      audience: "carbon-registry", scope: request.scope, permission: registryPermission(request.command.kind),
      request: { method: "POST", path, bodyDigest: createHash("sha256").update(body).digest("hex") },
    });
    if (!profile.grant.permissions.includes(exchange.permission)) throw new Error("The active device grant does not include this registry permission");
    const assertionResponse = await this.transport(`${cloud}/platform/v1/device/registry-assertions`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify(exchange),
    }).catch(() => { throw new Error("Carbon Cloud could not be reached"); });
    if (assertionResponse.status !== 200) { await assertionResponse.body?.cancel(); throw new Error(assertionResponse.status === 401 ? "The device credential is invalid or revoked" : assertionResponse.status === 403 ? "The device credential cannot perform this request" : "Carbon Cloud could not issue a Registry assertion"); }
    const assertion = parseComponent("DeviceAssertionResponse", await boundedJson(assertionResponse, requestId));
    const response = await this.transport(registry + path, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${assertion.token}`, "content-type": "application/json", "x-request-id": requestId }, body })
      .catch(() => { throw new Error("Carbon Registry could not be reached"); });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(response.status === 401 ? "Carbon Registry rejected the assertion" : response.status === 403 ? "Carbon Registry denied the request" : response.status === 404 ? "The registry namespace was not found" : "Carbon Registry could not complete the request"); }
    const result = parseComponent("RegistryResponse", await boundedJson(response, requestId));
    if (result.bindingId !== request.bindingId || result.scope.environmentId !== request.scope.environmentId || result.scope.projectId !== request.scope.projectId || result.scope.orgId !== request.scope.orgId) throw new Error("Carbon Registry returned a mismatched scope");
    return result;
  }
}
