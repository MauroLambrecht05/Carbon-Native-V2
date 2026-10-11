// Calls the part of Carbon Cloud's API that takes a device (`dc_`) or
// personal (`pt_`) credential: builds, releases, channels and functions of
// one environment. See products/carbon-cloud/docs/credential-api.md.
//
// What is sent is the credential and nothing a browser would send: no
// cookie, no Origin. Every reply must be JSON, must not be a redirect, and
// must carry back the request ID this client chose.

import { randomUUID } from "node:crypto";
import { parseComponent, type EnvironmentScope } from "@carbon/contracts/platform";
import type { HttpTransport } from "./DeviceAuthorizationClient.ts";
import type { DeviceCredentialStore } from "./DeviceCredentialStore.ts";

const MAX_RESPONSE_BYTES = 2_179_072;

/** A credential and the one environment it is being used for. */
export interface PlatformCredential { readonly controlPlaneUrl: string; readonly token: string; readonly scope: EnvironmentScope }

/** Cloud refused the request. `code` is Cloud's own error code; `message` is safe to show. */
export class PlatformApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function origin(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new Error("Carbon Cloud URL is not a valid URL"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Carbon Cloud URL must be an HTTPS or loopback origin");
  return url.origin;
}

/**
 * Where the credential comes from. `CARBON_TOKEN` names one outright, for automation: it then needs the Cloud URL
 * and the environment spelled out, because a personal credential does not say where it is to be used. Without it,
 * the active `carbon cloud login` is used, which already carries both.
 */
export async function resolvePlatformCredential(store: Pick<DeviceCredentialStore, "active">, env: NodeJS.ProcessEnv = process.env): Promise<PlatformCredential> {
  const token = env.CARBON_TOKEN;
  if (token) {
    if (!/^(?:dc|pt)_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("CARBON_TOKEN is not a device or personal credential");
    const missing = ["CARBON_CLOUD_URL", "CARBON_ORG", "CARBON_PROJECT", "CARBON_ENVIRONMENT"].filter(name => !env[name]);
    if (missing.length) throw new Error(`CARBON_TOKEN also needs ${missing.join(", ")}`);
    let scope: EnvironmentScope;
    try { scope = parseComponent("EnvironmentScope", { orgId: env.CARBON_ORG, projectId: env.CARBON_PROJECT, environmentId: env.CARBON_ENVIRONMENT }); }
    catch { throw new Error("CARBON_ORG, CARBON_PROJECT and CARBON_ENVIRONMENT must be identifiers"); }
    return { controlPlaneUrl: origin(env.CARBON_CLOUD_URL!), token, scope };
  }
  const active = await store.active();
  if (!active) throw new Error("no active device login — run `carbon cloud login`, or set CARBON_TOKEN");
  const granted = active.profile.grant.scope;
  if (!granted.projectId || !granted.environmentId || granted.realmId) throw new Error("the active device login is not for one environment; log in again for the environment to work in");
  return { controlPlaneUrl: origin(active.profile.controlPlaneUrl), token: active.token,
    scope: parseComponent("EnvironmentScope", { orgId: granted.orgId, projectId: granted.projectId, environmentId: granted.environmentId }) };
}

export interface PlatformRequest {
  readonly method: "GET" | "POST";
  /** Below the environment, starting with a slash: `/functions`, `/builds/{id}/logs?after=3`. */
  readonly path: string;
  readonly body?: unknown;
  /** The revision the command expects the resource to be at. Sent as `If-Match`. */
  readonly revision?: string;
  /** One key per intended command. Sending the same key again repeats nothing. */
  readonly idempotencyKey?: string;
}

export class PlatformCredentialClient {
  constructor(private readonly transport: HttpTransport = fetch) {}

  async request(credential: PlatformCredential, input: PlatformRequest): Promise<unknown> {
    if (!/^(?:dc|pt)_[A-Za-z0-9_-]{43}$/.test(credential.token)) throw new Error("The credential is not a device or personal credential");
    if (!/^\/[A-Za-z0-9/_.~-]*(\?[A-Za-z0-9=&_.~%-]*)?$/.test(input.path) || input.path.includes("..") || input.path.includes("//")) throw new Error("Invalid API path");
    const scope = parseComponent("EnvironmentScope", credential.scope); const requestId = randomUUID();
    const url = `${origin(credential.controlPlaneUrl)}/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}${input.path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${credential.token}`, accept: "application/json", "x-request-id": requestId };
    let body: string | undefined;
    if (input.method === "POST") {
      body = JSON.stringify(input.body ?? {}); headers["content-type"] = "application/json";
      headers["idempotency-key"] = input.idempotencyKey ?? randomUUID();
      if (input.revision !== undefined) headers["if-match"] = input.revision;
    }
    const response = await this.transport(url, { method: input.method, redirect: "error", signal: AbortSignal.timeout(30_000), headers, body }).catch(() => { throw new Error("Carbon Cloud could not be reached"); });
    const value = await this.read(response, requestId);
    if (response.status >= 200 && response.status < 300) return value;
    const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new PlatformApiError(response.status, typeof error?.code === "string" ? error.code : "unavailable",
      response.status === 401 ? "The credential is invalid, expired or revoked" : typeof error?.message === "string" && error.message.length <= 300 ? error.message : `Carbon Cloud answered ${response.status}`);
  }

  private async read(response: Response, requestId: string): Promise<unknown> {
    if (response.redirected || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || response.headers.get("x-request-id") !== requestId) {
      await response.body?.cancel(); throw new Error("Carbon Cloud returned an invalid response");
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error("Carbon Cloud returned an empty response");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_RESPONSE_BYTES) throw new Error("Carbon Cloud returned an oversized response"); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Carbon Cloud returned invalid JSON"); }
  }
}
