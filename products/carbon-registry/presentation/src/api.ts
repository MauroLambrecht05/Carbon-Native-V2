// Typed Client SDK for Carbon Plugin Registry

export interface PluginSummary {
  name: string;
  category: string;
  description: string;
  authorName: string;
  latestVersion: string;
  downloads: number;
  verified: boolean;
  tags: string[];
  platforms: string[];
  createdAt: string;
}

export interface PluginDetail extends PluginSummary {
  authorOrgId: string;
  readme: string;
  versions: Record<string, {
    version: string;
    checksumSha256: string;
    platforms: string[];
    abiVersion: string;
    permissions: string[];
    publishedAt: string;
  }>;
}

export interface RegistryStats {
  totalPackages: number;
  totalDownloads: number;
  totalAuthors: number;
  categories: string[];
}

export class CarbonRegistryClient {
  constructor(
    private readonly baseUrl: string = "http://localhost:54323",
    private apiToken?: string,
  ) {}

  setToken(token: string): void {
    this.apiToken = token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  async getHealth(): Promise<{ status: string; service: string }> {
    return this.request("/api/v1/health");
  }

  async getStats(): Promise<RegistryStats> {
    return this.request("/api/v1/stats");
  }

  async getCategories(): Promise<string[]> {
    return this.request("/api/v1/categories");
  }

  async listPlugins(params: {
    category?: string;
    search?: string;
    platform?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ plugins: PluginSummary[]; total: number }> {
    const qs = new URLSearchParams();
    if (params.category) qs.set("category", params.category);
    if (params.search) qs.set("search", params.search);
    if (params.platform) qs.set("platform", params.platform);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));

    const query = qs.toString();
    return this.request(`/api/v1/plugins${query ? `?${query}` : ""}`);
  }

  async getPlugin(name: string): Promise<PluginDetail> {
    return this.request(`/api/v1/plugins/${name}`);
  }

  async downloadPlugin(name: string, version?: string): Promise<{
    tarballBase64: string;
    checksum: string;
    version: string;
  }> {
    const path = version ? `/api/v1/plugins/${name}/${version}/download` : `/api/v1/plugins/${name}/download`;
    return this.request(path);
  }

  async publishPlugin(data: {
    manifest: {
      name: string;
      version: string;
      category: string;
      description: string;
      abiVersion?: string;
      platforms?: string[];
      permissions?: string[];
    };
    readme?: string;
    tarballBase64: string;
    authorName?: string;
    tags?: string[];
  }): Promise<{ success: boolean; name: string; version: string; checksum: string }> {
    return this.request("/api/v1/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  }
}
