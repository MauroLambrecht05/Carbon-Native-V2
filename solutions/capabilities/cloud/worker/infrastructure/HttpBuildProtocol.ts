// BuildProtocol over Cloud's worker API (/worker/v1). Every call is a POST
// authenticated by the worker credential; lease calls add the lease token.

import { parseComponent, type BuildArtifactDeclare, type WorkerBuildComplete, type WorkerBuildInput, type WorkerCapabilities, type WorkerLeaseOffer, type WorkerSecretBinding } from "@carbon/contracts/platform";
import { LeaseLostError, type BuildProtocol, type HeldBuildLease } from "../application/ports/LeasedBuild.ts";

/** Cloud refused a worker call. Carries the status and Cloud's error code, never a response body. */
export class WorkerProtocolError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`The worker API returned ${status} (${code})`); }
}

async function post(transport: typeof fetch, url: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
  const response = await transport(url, { method: "POST", headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => undefined) as { error?: { code?: unknown } } | undefined;
  if (!response.ok) throw new WorkerProtocolError(response.status, typeof payload?.error?.code === "string" ? payload.error.code : "unknown");
  return payload;
}

export class HttpBuildProtocol implements BuildProtocol {
  private readonly base: string;
  constructor(cloudUrl: string, private readonly token: string, private readonly transport: typeof fetch = fetch) {
    this.base = `${cloudUrl.replace(/\/+$/, "")}/worker/v1`;
  }

  /** Trades a one-time enrollment code for this worker's credential. The token is returned once and never again. */
  static async enroll(cloudUrl: string, code: string, capabilities: WorkerCapabilities, transport: typeof fetch = fetch): Promise<string> {
    return parseComponent("WorkerCredentialIssue", await post(transport, `${cloudUrl.replace(/\/+$/, "")}/worker/v1/enroll`, {}, { code, capabilities })).token;
  }

  private async call(path: string, lease?: HeldBuildLease, body?: unknown): Promise<unknown> {
    try {
      return await post(this.transport, this.base + path, { authorization: `Bearer ${this.token}`, ...(lease ? { "x-carbon-lease-token": lease.leaseToken } : {}) }, body);
    } catch (error) {
      // On a lease call, a conflict means the lease is cancelled, expired or held by someone else now.
      if (lease && error instanceof WorkerProtocolError && error.status === 409 && !path.endsWith("/artifacts") && !path.endsWith("/complete")) throw new LeaseLostError();
      throw error;
    }
  }

  async claim(): Promise<WorkerLeaseOffer> { return parseComponent("WorkerLeaseOffer", await this.call("/leases/claim")); }
  async heartbeat(lease: HeldBuildLease) { return { cancelled: parseComponent("WorkerLeaseReceipt", await this.call(`/leases/${lease.leaseId}`, lease, { kind: "heartbeat" })).cancelled }; }
  async input(lease: HeldBuildLease): Promise<WorkerBuildInput> { return parseComponent("WorkerBuildInput", await this.call(`/leases/${lease.leaseId}/build`, lease)); }
  async secrets(lease: HeldBuildLease): Promise<readonly WorkerSecretBinding[]> { return parseComponent("WorkerSecretBindings", await this.call(`/leases/${lease.leaseId}/secrets`, lease)).bindings; }
  async appendLog(lease: HeldBuildLease, sequence: number, text: string): Promise<void> { await this.call(`/leases/${lease.leaseId}/build/logs`, lease, { sequence, text }); }
  async declareArtifact(lease: HeldBuildLease, artifact: BuildArtifactDeclare): Promise<void> { await this.call(`/leases/${lease.leaseId}/build/artifacts`, lease, artifact); }
  async complete(lease: HeldBuildLease, result: WorkerBuildComplete): Promise<void> { await this.call(`/leases/${lease.leaseId}/build/complete`, lease, result); }
}
