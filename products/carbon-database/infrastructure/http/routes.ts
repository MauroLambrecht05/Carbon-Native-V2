// REST API surface for carbon-database. Every route does request parsing,
// verifies identity tokens against carbon-cloud's real identity (see
// HttpIdentityClient — this product keeps NO organizations/api_tokens of
// its own), and calls the appropriate engine.
//
// SIGNUP AND BILLING ARE REAL PROXIES TO CARBON-CLOUD, NOT REIMPLEMENTED
// HERE: an org is created once, on carbon-cloud (`POST /v1/orgs`); this
// product's own `/api/auth/register`/`/api/auth/me`/`/api/projects/:id/
// billing*` routes forward to carbon-cloud's real endpoints so the
// EXISTING presentation client (api.ts) keeps working unchanged, while
// the actual org/billing state genuinely lives in exactly one place.
// `/billing/confirm` has no real equivalent once billing goes through a
// genuine Stripe Checkout session (confirmation is an async webhook, not
// a synchronous frontend call) — it 501s with an explanation rather than
// faking a synchronous success the way the in-memory version did.

import { type VerifiedToken } from "@carbon/identity";
import { DatabaseEngine } from "../services/DatabaseEngine.ts";
import { VectorEngine } from "../services/VectorEngine.ts";
import { GraphEngine } from "../services/GraphEngine.ts";
import { EdgeFunctionsEngine } from "../services/EdgeFunctionsEngine.ts";
import { StorageEngine } from "../services/StorageEngine.ts";
import { RlsPolicyEngine, type RlsContext } from "../services/RlsPolicyEngine.ts";
import { handlePostgrestRequest } from "./postgrest.ts";
import { SnapshotEngine, type ProjectSnapshot } from "../persistence/SnapshotEngine.ts";
import { MigrationEngine } from "../persistence/MigrationEngine.ts";

export interface DatabaseRouteDeps {
  readonly sql: Bun.SQL;
  readonly controlPlaneUrl: string;
  readonly verifyToken: { execute(token: string): Promise<VerifiedToken | null> };
  readonly databaseEngine: DatabaseEngine;
  readonly vectorEngine: VectorEngine;
  readonly graphEngine: GraphEngine;
  readonly edgeFunctionsEngine: EdgeFunctionsEngine;
  readonly storageEngine: StorageEngine;
  readonly rlsEngine: RlsPolicyEngine;
  readonly migrationEngine: MigrationEngine;
  readonly snapshotEngine: SnapshotEngine;
}

interface ProjectRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export function buildDatabaseRoutes(deps: DatabaseRouteDeps) {
  const dbEngine = deps.databaseEngine;
  const vectorEngine = deps.vectorEngine;
  const graphEngine = deps.graphEngine;
  const edgeEngine = deps.edgeFunctionsEngine;
  const storageEngine = deps.storageEngine;
  const rls = deps.rlsEngine;

  function json(body: unknown, status = 200): Response {
    return Response.json(body, {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-carbon-token",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      },
    });
  }

  async function authenticate(req: Request): Promise<VerifiedToken> {
    const authHeader = req.headers.get("Authorization") || req.headers.get("x-carbon-token");
    if (!authHeader) {
      throw new Error("Missing authentication token. Provide Authorization: Bearer <token>");
    }
    const rawToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    const verified = await deps.verifyToken.execute(rawToken);
    if (!verified) throw new Error("invalid token");
    return verified;
  }

  async function findOrgProject(orgId: string): Promise<ProjectRecord | undefined> {
    const rows = await deps.sql<Array<{ id: string; org_id: string; name: string; created_at: Date }>>`
      SELECT id, org_id, name, created_at FROM projects WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { id: row.id, orgId: row.org_id, name: row.name, createdAt: new Date(row.created_at) };
  }

  // Every call carbon-database makes back to carbon-cloud forwards the
  // SAME bearer token the caller sent — carbon-database never holds a
  // credential of its own to authenticate as the caller's org.
  function forwardAuthHeader(req: Request): HeadersInit {
    const auth = req.headers.get("Authorization") || req.headers.get("x-carbon-token");
    return auth ? { authorization: auth.startsWith("Bearer ") ? auth : `Bearer ${auth}` } : {};
  }

  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-carbon-token",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        },
      });
    }

    try {
      // 1. Health
      if (path === "/api/health") {
        return json({
          status: "healthy",
          product: "carbon-database",
          version: "0.2.0",
          engines: ["relational", "vector", "graph", "edge-functions", "storage"],
          identity: "delegated to carbon-cloud (real SSO)",
        });
      }

      // 2. Auth: signup — a real proxy to carbon-cloud's own /v1/orgs.
      if (path === "/api/auth/register" && method === "POST") {
        const body = (await req.json()) as { organizationName?: string };
        const orgName = body.organizationName || `org-${Date.now()}`;
        const res = await fetch(`${deps.controlPlaneUrl}/v1/orgs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: orgName }),
        });
        if (!res.ok) return json(await res.json().catch(() => ({ error: "signup failed" })), res.status);
        const orgResult = (await res.json()) as { orgId: string; apiToken: string };

        const defaultProject: ProjectRecord = {
          id: `proj-${orgResult.orgId.slice(0, 8)}`,
          orgId: orgResult.orgId,
          name: "Default Project",
          createdAt: new Date(),
        };
        await deps.sql`
          INSERT INTO projects (id, org_id, name, created_at) VALUES (${defaultProject.id}, ${defaultProject.orgId}, ${defaultProject.name}, ${defaultProject.createdAt})
          ON CONFLICT (id) DO NOTHING
        `;

        return json(
          { organization: { id: orgResult.orgId, name: orgName }, apiToken: orgResult.apiToken, defaultProjectId: defaultProject.id },
          201,
        );
      }

      // 3. Auth: current session — verified against carbon-cloud.
      if (path === "/api/auth/me" && method === "GET") {
        const verified = await authenticate(req);
        return json({ orgId: verified.orgId, scope: verified.scope });
      }

      // 4. Projects
      if (path === "/api/projects" && method === "GET") {
        const verified = await authenticate(req);
        const rows = await deps.sql<Array<{ id: string; org_id: string; name: string; created_at: Date }>>`
          SELECT id, org_id, name, created_at FROM projects WHERE org_id = ${verified.orgId}
        `;
        return json(rows.map((r) => ({ id: r.id, orgId: r.org_id, name: r.name, createdAt: r.created_at })));
      }

      if (path === "/api/projects" && method === "POST") {
        const verified = await authenticate(req);
        const body = (await req.json()) as { name: string };
        if (!body.name) return json({ error: "Project name is required" }, 400);

        const project: ProjectRecord = {
          id: `proj-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          orgId: verified.orgId,
          name: body.name,
          createdAt: new Date(),
        };
        await deps.sql`
          INSERT INTO projects (id, org_id, name, created_at) VALUES (${project.id}, ${project.orgId}, ${project.name}, ${project.createdAt})
        `;
        return json(project, 201);
      }

      // 5. Database & Tables: /api/projects/:projectId/tables
      const tablesMatch = path.match(/^\/api\/projects\/([^/]+)\/tables$/);
      if (tablesMatch) {
        const projectId = tablesMatch[1]!;
        await authenticate(req);
        if (method === "GET") return json(await dbEngine.listTables(projectId));
        if (method === "POST") {
          const body = (await req.json()) as { name: string; columns: any[] };
          const table = await dbEngine.createTable(projectId, body.name, body.columns || []);
          return json(table, 201);
        }
      }

      const rowsMatch = path.match(/^\/api\/projects\/([^/]+)\/tables\/([^/]+)\/rows$/);
      if (rowsMatch) {
        const projectId = rowsMatch[1]!;
        const tableName = rowsMatch[2]!;
        await authenticate(req);
        if (method === "GET") {
          const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 100;
          return json(await dbEngine.queryRows(projectId, tableName, { limit }));
        }
        if (method === "POST") {
          const data = (await req.json()) as Record<string, unknown>;
          return json(await dbEngine.insertRow(projectId, tableName, data), 201);
        }
      }

      // PostgREST-compliant endpoint: /rest/v1/:tableName
      const postgrestMatch = path.match(/^\/rest\/v1\/([^/]+)$/);
      if (postgrestMatch) {
        const tableName = postgrestMatch[1]!;
        let verified: VerifiedToken | undefined;
        try {
          verified = await authenticate(req);
        } catch {
          // Allow anonymous access if no token; RLS policies decide access
        }

        const projectId =
          req.headers.get("x-carbon-project") ||
          url.searchParams.get("projectId") ||
          (verified ? (await findOrgProject(verified.orgId))?.id : undefined) ||
          "default";

        const rlsContext: RlsContext = verified
          ? { orgId: verified.orgId, role: "authenticated" }
          : { orgId: "anon", role: "anon" };

        return await handlePostgrestRequest(req, projectId, tableName, dbEngine, rlsContext);
      }

      // RLS Policy routes: /api/projects/:projectId/tables/:tableName/rls
      const rlsMatch = path.match(/^\/api\/projects\/([^/]+)\/tables\/([^/]+)\/rls$/);
      if (rlsMatch) {
        const projectId = rlsMatch[1]!;
        const tableName = rlsMatch[2]!;
        await authenticate(req);
        if (method === "GET") {
          return json({ enabled: rls.isRlsEnabled(projectId, tableName), policies: rls.listPolicies(projectId, tableName) });
        }
        if (method === "POST") {
          const body = (await req.json()) as { enabled: boolean };
          await rls.setRlsEnabled(projectId, tableName, Boolean(body.enabled));
          return json({ success: true, enabled: Boolean(body.enabled) });
        }
      }

      const policiesMatch = path.match(/^\/api\/projects\/([^/]+)\/tables\/([^/]+)\/policies$/);
      if (policiesMatch) {
        const projectId = policiesMatch[1]!;
        const tableName = policiesMatch[2]!;
        await authenticate(req);
        if (method === "GET") return json(rls.listPolicies(projectId, tableName));
        if (method === "POST") {
          const body = (await req.json()) as {
            name: string;
            action: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";
            ruleExpression?: string;
          };
          const policyId = `pol_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          await rls.addPolicy(projectId, tableName, {
            id: policyId,
            name: body.name,
            action: body.action || "ALL",
            ruleExpression: body.ruleExpression,
          });
          return json({ id: policyId, name: body.name, action: body.action }, 201);
        }
      }

      // Raw SQL: /api/projects/:projectId/sql
      const sqlMatch = path.match(/^\/api\/projects\/([^/]+)\/sql$/);
      if (sqlMatch && method === "POST") {
        const projectId = sqlMatch[1]!;
        await authenticate(req);
        const body = (await req.json()) as { query: string };
        return json(await dbEngine.executeRawSql(projectId, body.query));
      }

      // Snapshot Export & Import
      const exportMatch = path.match(/^\/api\/projects\/([^/]+)\/export$/);
      if (exportMatch && method === "GET") {
        const projectId = exportMatch[1]!;
        await authenticate(req);
        return json(await deps.snapshotEngine.exportSnapshot(projectId));
      }

      const importMatch = path.match(/^\/api\/projects\/([^/]+)\/import$/);
      if (importMatch && method === "POST") {
        const projectId = importMatch[1]!;
        await authenticate(req);
        const snapshot = (await req.json()) as ProjectSnapshot;
        await deps.snapshotEngine.importSnapshot(projectId, snapshot);
        return json({ success: true, projectId });
      }

      // Schema Migrations
      const migrationsMatch = path.match(/^\/api\/projects\/([^/]+)\/migrations$/);
      if (migrationsMatch) {
        const projectId = migrationsMatch[1]!;
        await authenticate(req);
        if (method === "GET") return json(await deps.migrationEngine.listMigrations(projectId));
        if (method === "POST") {
          const body = (await req.json()) as { version: number; name: string; sql: string };
          return json(await deps.migrationEngine.applyMigration(projectId, body.version, body.name, body.sql), 201);
        }
      }

      // 6. Vectors
      const vecColMatch = path.match(/^\/api\/projects\/([^/]+)\/vectors\/collections$/);
      if (vecColMatch) {
        const projectId = vecColMatch[1]!;
        await authenticate(req);
        if (method === "GET") return json(await vectorEngine.listCollections(projectId));
        if (method === "POST") {
          const body = (await req.json()) as { name: string; dimension: number };
          return json(await vectorEngine.createCollection(projectId, body.name, body.dimension), 201);
        }
      }

      const vecInsertMatch = path.match(/^\/api\/projects\/([^/]+)\/vectors\/collections\/([^/]+)\/insert$/);
      if (vecInsertMatch && method === "POST") {
        const projectId = vecInsertMatch[1]!;
        const collection = vecInsertMatch[2]!;
        await authenticate(req);
        const body = (await req.json()) as { points: any[] };
        const count = await vectorEngine.insertVectors(projectId, collection, body.points || []);
        return json({ inserted: count });
      }

      const vecSearchMatch = path.match(/^\/api\/projects\/([^/]+)\/vectors\/collections\/([^/]+)\/search$/);
      if (vecSearchMatch && method === "POST") {
        const projectId = vecSearchMatch[1]!;
        const collection = vecSearchMatch[2]!;
        await authenticate(req);
        const body = (await req.json()) as { queryVector: number[]; topK?: number; minScore?: number };
        return json(await vectorEngine.search(projectId, collection, body.queryVector, body.topK, body.minScore));
      }

      // 7. Graph
      const graphNodesMatch = path.match(/^\/api\/projects\/([^/]+)\/graph\/nodes$/);
      if (graphNodesMatch) {
        const projectId = graphNodesMatch[1]!;
        await authenticate(req);
        if (method === "GET") return json(await graphEngine.listNodes(projectId));
        if (method === "POST") {
          const body = (await req.json()) as { id: string; label: string; properties?: Record<string, unknown> };
          return json(await graphEngine.addNode(projectId, body.id, body.label, body.properties), 201);
        }
      }

      const graphEdgesMatch = path.match(/^\/api\/projects\/([^/]+)\/graph\/edges$/);
      if (graphEdgesMatch) {
        const projectId = graphEdgesMatch[1]!;
        await authenticate(req);
        if (method === "GET") return json(await graphEngine.listEdges(projectId));
        if (method === "POST") {
          const body = (await req.json()) as {
            sourceId: string;
            targetId: string;
            relationship: string;
            weight?: number;
            properties?: Record<string, unknown>;
          };
          return json(
            await graphEngine.addEdge(projectId, body.sourceId, body.targetId, body.relationship, body.weight ?? 1, body.properties),
            201,
          );
        }
      }

      const graphPathMatch = path.match(/^\/api\/projects\/([^/]+)\/graph\/path$/);
      if (graphPathMatch && method === "POST") {
        const projectId = graphPathMatch[1]!;
        await authenticate(req);
        const body = (await req.json()) as { sourceId: string; targetId: string };
        const pathResult = await graphEngine.findShortestPath(projectId, body.sourceId, body.targetId);
        return json(pathResult ?? { path: [], totalWeight: -1, found: false });
      }

      // 8. Edge Functions
      const funcsMatch = path.match(/^\/api\/projects\/([^/]+)\/functions$/);
      if (funcsMatch) {
        const projectId = funcsMatch[1]!;
        await authenticate(req);
        if (method === "GET") return json(await edgeEngine.listFunctions(projectId));
        if (method === "POST") {
          const body = (await req.json()) as { name: string; code: string; envVars?: Record<string, string> };
          return json(await edgeEngine.deployFunction(projectId, body.name, body.code, body.envVars), 201);
        }
      }

      const fnInvokeMatch = path.match(/^\/api\/projects\/([^/]+)\/functions\/([^/]+)\/invoke$/);
      if (fnInvokeMatch && method === "POST") {
        const projectId = fnInvokeMatch[1]!;
        const fnName = fnInvokeMatch[2]!;
        await authenticate(req);
        const body = await req.json().catch(() => ({}));
        return json(await edgeEngine.invokeFunction(projectId, fnName, body));
      }

      // 9. Storage
      const bucketsMatch = path.match(/^\/api\/projects\/([^/]+)\/storage\/buckets$/);
      if (bucketsMatch) {
        const projectId = bucketsMatch[1]!;
        await authenticate(req);
        if (method === "GET") return json(await storageEngine.listBuckets(projectId));
        if (method === "POST") {
          const body = (await req.json()) as { name: string; isPublic?: boolean };
          return json(await storageEngine.createBucket(projectId, body.name, body.isPublic ?? true), 201);
        }
      }

      const filesMatch = path.match(/^\/api\/projects\/([^/]+)\/storage\/buckets\/([^/]+)\/files$/);
      if (filesMatch && method === "GET") {
        const projectId = filesMatch[1]!;
        const bucket = filesMatch[2]!;
        await authenticate(req);
        return json(await storageEngine.listFiles(projectId, bucket));
      }

      const uploadMatch = path.match(/^\/api\/projects\/([^/]+)\/storage\/buckets\/([^/]+)\/upload$/);
      if (uploadMatch && method === "POST") {
        const projectId = uploadMatch[1]!;
        const bucket = uploadMatch[2]!;
        await authenticate(req);
        const body = (await req.json()) as { path: string; content: string; contentType?: string };
        const stored = await storageEngine.uploadFile(projectId, bucket, body.path, body.content, body.contentType);
        const publicUrl = storageEngine.getPublicUrl(projectId, bucket, stored.path);
        return json({ ...stored, publicUrl }, 201);
      }

      // Storage: Public Object Download
      const publicDownloadMatch = path.match(/^\/storage\/v1\/object\/public\/([^/]+)\/([^/]+)\/(.+)$/);
      if (publicDownloadMatch && method === "GET") {
        const projectId = publicDownloadMatch[1]!;
        const bucket = publicDownloadMatch[2]!;
        const filePath = publicDownloadMatch[3]!;
        const file = await storageEngine.getFile(projectId, bucket, filePath);
        if (!file) return json({ error: "File not found" }, 404);
        return new Response(file.content, {
          headers: {
            "Content-Type": file.contentType,
            "Content-Length": String(file.size),
            "Cache-Control": "public, max-age=3600",
          },
        });
      }

      // 10. Billing: real proxies to carbon-cloud
      const billingMatch = path.match(/^\/api\/projects\/([^/]+)\/billing$/);
      if (billingMatch && method === "GET") {
        await authenticate(req);
        const res = await fetch(`${deps.controlPlaneUrl}/v1/usage`, { headers: forwardAuthHeader(req) });
        return json(await res.json().catch(() => ({})), res.status);
      }

      const upgradeMatch = path.match(/^\/api\/projects\/([^/]+)\/billing\/upgrade$/);
      if (upgradeMatch && method === "POST") {
        await authenticate(req);
        const body = (await req.json()) as { targetPlan?: string };
        const res = await fetch(`${deps.controlPlaneUrl}/v1/billing/checkout`, {
          method: "POST",
          headers: { ...forwardAuthHeader(req), "content-type": "application/json" },
          body: JSON.stringify({ plan: body.targetPlan || "pro" }),
        });
        return json(await res.json().catch(() => ({})), res.status);
      }

      const confirmUpgradeMatch = path.match(/^\/api\/projects\/([^/]+)\/billing\/confirm$/);
      if (confirmUpgradeMatch && method === "POST") {
        // No real equivalent once billing goes through an actual Stripe
        // Checkout session — confirmation is carbon-cloud's own webhook
        // handler reacting to a real `checkout.session.completed` event,
        // not something a frontend can synchronously trigger. See this
        // file's own header comment.
        return json(
          { error: "billing confirmation now happens via carbon-cloud's Stripe webhook, not a direct call" },
          501,
        );
      }

      return json({ error: `Not Found: ${method} ${path}` }, 404);
    } catch (err: any) {
      const message = err.message || "Internal Server Error";
      const status = message === "invalid token" || message.startsWith("Missing authentication") ? 401 : 400;
      return json({ error: message }, status);
    }
  };
}
