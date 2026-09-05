// Typed API Client for Carbon Database Studio

export class CarbonDatabaseClient {
  constructor(
    private readonly baseUrl: string = "",
    private apiToken: string = "",
  ) {}

  setToken(token: string): void {
    this.apiToken = token;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "application/json");
    if (this.apiToken) {
      headers.set("Authorization", `Bearer ${this.apiToken}`);
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }

    return (await res.json()) as T;
  }

  // Health
  getHealth() {
    return this.request<{ status: string; product: string; version: string }>("/api/health");
  }

  // Auth & Org
  registerOrg(organizationName: string) {
    return this.request<{
      organization: { id: string; name: string; plan: string };
      apiToken: string;
      defaultProjectId: string;
    }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ organizationName }),
    });
  }

  getMe() {
    return this.request<{ orgId: string; scope: string; billing: unknown }>("/api/auth/me");
  }

  // Projects
  listProjects() {
    return this.request<any[]>("/api/projects");
  }

  createProject(name: string) {
    return this.request<any>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  // Tables
  listTables(projectId: string) {
    return this.request<any[]>(`/api/projects/${projectId}/tables`);
  }

  createTable(projectId: string, name: string, columns: any[]) {
    return this.request<any>(`/api/projects/${projectId}/tables`, {
      method: "POST",
      body: JSON.stringify({ name, columns }),
    });
  }

  queryRows(projectId: string, tableName: string, limit = 100) {
    return this.request<{ rows: any[]; total: number }>(`/api/projects/${projectId}/tables/${tableName}/rows?limit=${limit}`);
  }

  insertRow(projectId: string, tableName: string, data: Record<string, unknown>) {
    return this.request<any>(`/api/projects/${projectId}/tables/${tableName}/rows`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  runSql(projectId: string, query: string) {
    return this.request<{ columns: string[]; rows: any[]; rowCount: number; executionTimeMs: number }>(
      `/api/projects/${projectId}/sql`,
      {
        method: "POST",
        body: JSON.stringify({ query }),
      },
    );
  }

  // Vectors
  createVectorCollection(projectId: string, name: string, dimension: number) {
    return this.request<any>(`/api/projects/${projectId}/vectors/collections`, {
      method: "POST",
      body: JSON.stringify({ name, dimension }),
    });
  }

  insertVectors(projectId: string, collection: string, points: any[]) {
    return this.request<{ inserted: number }>(`/api/projects/${projectId}/vectors/collections/${collection}/insert`, {
      method: "POST",
      body: JSON.stringify({ points }),
    });
  }

  searchVectors(projectId: string, collection: string, queryVector: number[], topK = 10) {
    return this.request<any[]>(`/api/projects/${projectId}/vectors/collections/${collection}/search`, {
      method: "POST",
      body: JSON.stringify({ queryVector, topK }),
    });
  }

  // Graph
  addNode(projectId: string, id: string, label: string, properties: Record<string, unknown> = {}) {
    return this.request<any>(`/api/projects/${projectId}/graph/nodes`, {
      method: "POST",
      body: JSON.stringify({ id, label, properties }),
    });
  }

  addEdge(projectId: string, sourceId: string, targetId: string, relationship: string, weight = 1) {
    return this.request<any>(`/api/projects/${projectId}/graph/edges`, {
      method: "POST",
      body: JSON.stringify({ sourceId, targetId, relationship, weight }),
    });
  }

  findPath(projectId: string, sourceId: string, targetId: string) {
    return this.request<{ path: any[]; totalWeight: number }>(`/api/projects/${projectId}/graph/path`, {
      method: "POST",
      body: JSON.stringify({ sourceId, targetId }),
    });
  }

  // Edge Functions
  deployFunction(projectId: string, name: string, code: string, envVars: Record<string, string> = {}) {
    return this.request<any>(`/api/projects/${projectId}/functions`, {
      method: "POST",
      body: JSON.stringify({ name, code, envVars }),
    });
  }

  invokeFunction(projectId: string, name: string, payload: unknown = {}) {
    return this.request<{ success: boolean; result?: unknown; error?: string; executionTimeMs: number }>(
      `/api/projects/${projectId}/functions/${name}/invoke`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  // Storage
  createBucket(projectId: string, name: string, isPublic = true) {
    return this.request<any>(`/api/projects/${projectId}/storage/buckets`, {
      method: "POST",
      body: JSON.stringify({ name, isPublic }),
    });
  }

  uploadFile(projectId: string, bucket: string, path: string, content: string, contentType = "text/plain") {
    return this.request<any>(`/api/projects/${projectId}/storage/buckets/${bucket}/upload`, {
      method: "POST",
      body: JSON.stringify({ path, content, contentType }),
    });
  }

  // Billing
  getBilling(projectId: string) {
    return this.request<any>(`/api/projects/${projectId}/billing`);
  }

  upgradePlan(projectId: string, planId = "pro") {
    return this.request<{ success: boolean; plan: string }>(`/api/projects/${projectId}/billing/confirm`, {
      method: "POST",
      body: JSON.stringify({ planId }),
    });
  }
}
