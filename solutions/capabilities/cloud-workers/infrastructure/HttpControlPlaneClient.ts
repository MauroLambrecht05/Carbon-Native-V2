// The real ControlPlaneClient, over plain HTTP against
// products/carbon-cloud/infrastructure/http's routes.

import type { TargetPlatform } from "@carbon/contracts/distribution";
import type { BuildArtifact, BuildProps } from "@carbon/cloud-orchestration";
import type { ControlPlaneClient } from "../application/ports/ControlPlaneClient.ts";

export class ControlPlaneRequestError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`control plane returned ${status}: ${body}`);
  }
}

export class HttpControlPlaneClient implements ControlPlaneClient {
  constructor(private readonly baseUrl: string, private readonly apiToken: string) {}

  private async request(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 204) {
      throw new ControlPlaneRequestError(res.status, await res.text());
    }
    return res;
  }

  async claimNext(platform: TargetPlatform, workerId: string): Promise<BuildProps | null> {
    const res = await this.request("/v1/builds/claim", { platform, workerId });
    if (res.status === 204) return null;
    return (await res.json()) as BuildProps;
  }

  async reportRunning(buildId: string): Promise<void> {
    await this.request(`/v1/builds/${buildId}/complete`, { outcome: "running" });
  }

  async reportSucceeded(buildId: string, artifacts: readonly BuildArtifact[]): Promise<void> {
    await this.request(`/v1/builds/${buildId}/complete`, { outcome: "succeeded", artifacts });
  }

  async reportFailed(buildId: string, error: string): Promise<void> {
    await this.request(`/v1/builds/${buildId}/complete`, { outcome: "failed", error });
  }
}
