// Typed Client SDK for Carbon Updater

import type { CheckUpdateResult } from "../../infrastructure/services/UpdateChecker.ts";
import type { PartitionState } from "../../infrastructure/services/PartitionManager.ts";

export class CarbonUpdaterClient {
  constructor(private readonly baseUrl = "http://localhost:54324") {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string>),
      },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  async getStatus(): Promise<{ status: string; partitions: PartitionState }> {
    return this.request("/api/v1/updater/status");
  }

  async checkForUpdates(params?: {
    currentVersion?: string;
    targetPlatform?: string;
    installationId?: string;
    manifestUrl?: string;
  }): Promise<CheckUpdateResult> {
    return this.request("/api/v1/updater/check", {
      method: "POST",
      body: JSON.stringify(params || {}),
    });
  }

  async promoteVersion(version: string): Promise<{ success: boolean; partitions: PartitionState }> {
    return this.request("/api/v1/updater/promote", {
      method: "POST",
      body: JSON.stringify({ version }),
    });
  }

  async reportCrash(): Promise<{ rollbackTriggered: boolean; activeVersion: string; reason?: string }> {
    return this.request("/api/v1/updater/report-crash", { method: "POST" });
  }

  async reportSuccess(): Promise<{ success: boolean }> {
    return this.request("/api/v1/updater/report-success", { method: "POST" });
  }

  async rollback(): Promise<{ success: boolean; activeVersion: string; partitions: PartitionState }> {
    return this.request("/api/v1/updater/rollback", { method: "POST" });
  }
}
