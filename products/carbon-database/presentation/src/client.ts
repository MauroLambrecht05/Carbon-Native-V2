// Fluent Client SDK for Carbon Database.
// Mirrors Supabase JS SDK conventions for maximum developer ergonomics.

export interface QueryFilter {
  column: string;
  operator: string;
  value: any;
}

export class QueryBuilder<T = Record<string, unknown>> implements PromiseLike<{ data: T[] | null; error: Error | null }> {
  private selectCols = "*";
  private readonly filters: QueryFilter[] = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitCount?: number;
  private offsetCount?: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly table: string,
    private readonly projectId: string = "default",
  ) {}

  select(columns = "*"): this {
    this.selectCols = columns;
    return this;
  }

  eq(column: string, value: any): this {
    this.filters.push({ column, operator: "eq", value });
    return this;
  }

  neq(column: string, value: any): this {
    this.filters.push({ column, operator: "neq", value });
    return this;
  }

  gt(column: string, value: any): this {
    this.filters.push({ column, operator: "gt", value });
    return this;
  }

  gte(column: string, value: any): this {
    this.filters.push({ column, operator: "gte", value });
    return this;
  }

  lt(column: string, value: any): this {
    this.filters.push({ column, operator: "lt", value });
    return this;
  }

  lte(column: string, value: any): this {
    this.filters.push({ column, operator: "lte", value });
    return this;
  }

  like(column: string, pattern: string): this {
    this.filters.push({ column, operator: "like", value: pattern });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orderCol = column;
    this.orderAsc = options.ascending ?? true;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  offset(count: number): this {
    this.offsetCount = count;
    return this;
  }

  private buildUrl(): string {
    const params = new URLSearchParams();
    if (this.selectCols !== "*") {
      params.set("select", this.selectCols);
    }
    for (const f of this.filters) {
      params.set(f.column, `${f.operator}.${f.value}`);
    }
    if (this.orderCol) {
      params.set("order", `${this.orderCol}.${this.orderAsc ? "asc" : "desc"}`);
    }
    if (this.limitCount !== undefined) {
      params.set("limit", String(this.limitCount));
    }
    if (this.offsetCount !== undefined) {
      params.set("offset", String(this.offsetCount));
    }

    const qs = params.toString();
    return `${this.baseUrl}/rest/v1/${this.table}${qs ? `?${qs}` : ""}`;
  }

  async then<TResult1 = { data: T[] | null; error: Error | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: T[] | null; error: Error | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    try {
      const url = this.buildUrl();
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "x-carbon-project": this.projectId,
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        const result = { data: null, error: new Error(err.error || `HTTP ${res.status}`) };
        return onfulfilled ? onfulfilled(result) : (result as any);
      }

      const json = (await res.json()) as T[];
      const result = { data: json, error: null };
      return onfulfilled ? onfulfilled(result) : (result as any);
    } catch (err: any) {
      const result = { data: null, error: err instanceof Error ? err : new Error(String(err)) };
      return onfulfilled ? onfulfilled(result) : (result as any);
    }
  }

  async insert(values: T | T[]): Promise<{ data: T | T[] | null; error: Error | null }> {
    try {
      const res = await fetch(`${this.baseUrl}/rest/v1/${this.table}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiToken}`,
          "x-carbon-project": this.projectId,
        },
        body: JSON.stringify(values),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        return { data: null, error: new Error(err.error || `HTTP ${res.status}`) };
      }

      const data = (await res.json()) as T | T[];
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async update(values: Partial<T>): Promise<{ updated: number; error: Error | null }> {
    try {
      const url = this.buildUrl();
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiToken}`,
          "x-carbon-project": this.projectId,
        },
        body: JSON.stringify(values),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        return { updated: 0, error: new Error(err.error || `HTTP ${res.status}`) };
      }

      const result = (await res.json()) as { updated: number };
      return { updated: result.updated, error: null };
    } catch (err: any) {
      return { updated: 0, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async delete(): Promise<{ deleted: number; error: Error | null }> {
    try {
      const url = this.buildUrl();
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "x-carbon-project": this.projectId,
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        return { deleted: 0, error: new Error(err.error || `HTTP ${res.status}`) };
      }

      const result = (await res.json()) as { deleted: number };
      return { deleted: result.deleted, error: null };
    } catch (err: any) {
      return { deleted: 0, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}

export class CarbonClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly defaultProjectId: string = "default",
  ) {}

  from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.baseUrl, this.apiToken, table, this.defaultProjectId);
  }

  get vectors() {
    return {
      createCollection: async (name: string, dimension: number, projectId = this.defaultProjectId) => {
        const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/vectors/collections`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
          body: JSON.stringify({ name, dimension }),
        });
        return res.json();
      },
      insert: async (collection: string, points: any[], projectId = this.defaultProjectId) => {
        const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/vectors/collections/${collection}/insert`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
          body: JSON.stringify({ points }),
        });
        return res.json();
      },
      search: async (
        collection: string,
        queryVector: number[],
        options: { topK?: number; minScore?: number } = {},
        projectId = this.defaultProjectId,
      ) => {
        const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/vectors/collections/${collection}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
          body: JSON.stringify({ queryVector, ...options }),
        });
        return res.json();
      },
    };
  }

  get graph() {
    return {
      addNode: async (id: string, label: string, properties: Record<string, unknown> = {}, projectId = this.defaultProjectId) => {
        const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/graph/nodes`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
          body: JSON.stringify({ id, label, properties }),
        });
        return res.json();
      },
      addEdge: async (
        sourceId: string,
        targetId: string,
        relationship: string,
        weight = 1,
        projectId = this.defaultProjectId,
      ) => {
        const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/graph/edges`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
          body: JSON.stringify({ sourceId, targetId, relationship, weight }),
        });
        return res.json();
      },
      findPath: async (sourceId: string, targetId: string, projectId = this.defaultProjectId) => {
        const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/graph/path`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
          body: JSON.stringify({ sourceId, targetId }),
        });
        return res.json();
      },
    };
  }

  get functions() {
    return {
      invoke: async (name: string, payload: unknown = {}, projectId = this.defaultProjectId) => {
        const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/functions/${name}/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
          body: JSON.stringify(payload),
        });
        return res.json();
      },
    };
  }

  get storage() {
    return {
      from: (bucket: string, projectId = this.defaultProjectId) => ({
        upload: async (path: string, content: string, contentType = "text/plain") => {
          const res = await fetch(`${this.baseUrl}/api/projects/${projectId}/storage/buckets/${bucket}/upload`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
            body: JSON.stringify({ path, content, contentType }),
          });
          return res.json();
        },
        getPublicUrl: (path: string) => {
          return `${this.baseUrl}/storage/v1/object/public/${projectId}/${bucket}/${path.replace(/^\/+/, "")}`;
        },
      }),
    };
  }
}

export function createCarbonClient(baseUrl: string, apiToken: string, defaultProjectId = "default"): CarbonClient {
  return new CarbonClient(baseUrl.replace(/\/+$/, ""), apiToken, defaultProjectId);
}
