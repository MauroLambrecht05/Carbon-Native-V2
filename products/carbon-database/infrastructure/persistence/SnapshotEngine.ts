// Snapshot Engine: Serializes database tables, vector collections,
// knowledge graph entities, edge functions, and storage to/from a plain
// JSON document — export/import go through each engine's own PUBLIC
// methods (never touch storage directly), so this file's own logic is
// almost unchanged from the in-memory version; only `await` and
// constructor-injected engines are new.

import type { DatabaseEngine } from "../services/DatabaseEngine.ts";
import type { VectorEngine } from "../services/VectorEngine.ts";
import type { GraphEngine, GraphNode, GraphEdge } from "../services/GraphEngine.ts";
import type { EdgeFunctionsEngine, EdgeFunctionMeta } from "../services/EdgeFunctionsEngine.ts";
import type { StorageEngine } from "../services/StorageEngine.ts";

export interface SerializedTable {
  readonly name: string;
  readonly columns: any[];
  readonly rows: Record<string, unknown>[];
  readonly createdAt: string;
}

export interface SerializedVectorCollection {
  readonly name: string;
  readonly dimension: number;
  readonly points: any[];
  readonly createdAt: string;
}

export interface SerializedGraph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

export interface SerializedStorageBucket {
  readonly name: string;
  readonly isPublic: boolean;
  readonly files: { path: string; content: string; contentType: string; size: number }[];
  readonly createdAt: string;
}

export interface ProjectSnapshot {
  readonly version: string;
  readonly projectId: string;
  readonly exportedAt: string;
  readonly tables: SerializedTable[];
  readonly vectorCollections: SerializedVectorCollection[];
  readonly graph: SerializedGraph;
  readonly edgeFunctions: EdgeFunctionMeta[];
  readonly storageBuckets: SerializedStorageBucket[];
}

export class SnapshotEngine {
  constructor(
    private readonly db: DatabaseEngine,
    private readonly vectors: VectorEngine,
    private readonly graph: GraphEngine,
    private readonly funcs: EdgeFunctionsEngine,
    private readonly storage: StorageEngine,
  ) {}

  async exportSnapshot(projectId: string): Promise<ProjectSnapshot> {
    const tablesList = await this.db.listTables(projectId);
    const serializedTables: SerializedTable[] = [];
    for (const t of tablesList) {
      const table = await this.db.getTable(projectId, t.name);
      if (!table) continue;
      const { rows } = await this.db.queryRows(projectId, t.name, { limit: Number.MAX_SAFE_INTEGER });
      serializedTables.push({
        name: table.name,
        columns: table.columns,
        rows,
        createdAt: table.createdAt.toISOString(),
      });
    }

    const vecList = await this.vectors.listCollections(projectId);
    const serializedVectors: SerializedVectorCollection[] = [];
    for (const v of vecList) {
      const col = await this.vectors.getCollection(projectId, v.name);
      if (!col) continue;
      const points = await this.vectors.listPoints(projectId, v.name);
      serializedVectors.push({
        name: col.name,
        dimension: col.dimension,
        points,
        createdAt: col.createdAt.toISOString(),
      });
    }

    const nodes = await this.graph.listNodes(projectId);
    const edges = await this.graph.listEdges(projectId);

    const fnList = await this.funcs.listFunctions(projectId);
    const serializedFuncs: EdgeFunctionMeta[] = [];
    for (const f of fnList) {
      const fn = await this.funcs.getFunction(projectId, f.name);
      if (fn) serializedFuncs.push(fn);
    }

    const bucketList = await this.storage.listBuckets(projectId);
    const serializedBuckets: SerializedStorageBucket[] = [];
    for (const b of bucketList) {
      const bucket = await this.storage.getBucket(projectId, b.name);
      if (!bucket) continue;
      const files = await this.storage.listFiles(projectId, b.name);
      const serializedFiles: SerializedStorageBucket["files"] = [];
      for (const f of files) {
        const stored = await this.storage.getFile(projectId, b.name, f.path);
        if (!stored) continue;
        serializedFiles.push({
          path: f.path,
          content: Buffer.from(stored.content).toString("base64"),
          contentType: f.contentType,
          size: f.size,
        });
      }
      serializedBuckets.push({
        name: bucket.name,
        isPublic: bucket.isPublic,
        files: serializedFiles,
        createdAt: bucket.createdAt.toISOString(),
      });
    }

    return {
      version: "2.0.0", // bumped: v1's storage `content` was raw text, v2's is base64 (real binary now, not just strings)
      projectId,
      exportedAt: new Date().toISOString(),
      tables: serializedTables,
      vectorCollections: serializedVectors,
      graph: { nodes, edges },
      edgeFunctions: serializedFuncs,
      storageBuckets: serializedBuckets,
    };
  }

  async importSnapshot(projectId: string, snapshot: ProjectSnapshot): Promise<void> {
    for (const t of snapshot.tables || []) {
      if (!(await this.db.getTable(projectId, t.name))) {
        await this.db.createTable(projectId, t.name, t.columns);
      }
      for (const row of t.rows || []) {
        await this.db.insertRow(projectId, t.name, row);
      }
    }

    for (const v of snapshot.vectorCollections || []) {
      if (!(await this.vectors.getCollection(projectId, v.name))) {
        await this.vectors.createCollection(projectId, v.name, v.dimension);
      }
      await this.vectors.insertVectors(projectId, v.name, v.points || []);
    }

    for (const node of snapshot.graph?.nodes || []) {
      if (!(await this.graph.getNode(projectId, node.id))) {
        await this.graph.addNode(projectId, node.id, node.label, node.properties);
      }
    }
    for (const edge of snapshot.graph?.edges || []) {
      await this.graph.addEdge(projectId, edge.sourceId, edge.targetId, edge.relationship, edge.weight, edge.properties);
    }

    for (const fn of snapshot.edgeFunctions || []) {
      await this.funcs.deployFunction(projectId, fn.name, fn.code, fn.envVars);
    }

    for (const b of snapshot.storageBuckets || []) {
      if (!(await this.storage.getBucket(projectId, b.name))) {
        await this.storage.createBucket(projectId, b.name, b.isPublic);
      }
      for (const file of b.files || []) {
        const content = Buffer.from(file.content, "base64");
        await this.storage.uploadFile(projectId, b.name, file.path, content, file.contentType);
      }
    }
  }

  async saveToDisk(filepath: string, projectId: string): Promise<void> {
    const snapshot = await this.exportSnapshot(projectId);
    await Bun.write(filepath, JSON.stringify(snapshot, null, 2));
  }

  async loadFromDisk(filepath: string, projectId: string): Promise<boolean> {
    const file = Bun.file(filepath);
    if (!(await file.exists())) return false;
    const content = await file.text();
    const snapshot = JSON.parse(content) as ProjectSnapshot;
    await this.importSnapshot(projectId, snapshot);
    return true;
  }
}
