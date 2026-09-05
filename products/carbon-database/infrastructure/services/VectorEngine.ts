// Real vector search: pgvector-backed, one shared `vector_points` table
// across every project/collection (see 0001_init.sql's own comment on
// why one table rather than one per collection — dimension is enforced
// at the application layer, same check the original in-memory engine did
// in JS, now against real rows instead of a Map). Cosine similarity via
// pgvector's `<=>` operator (cosine DISTANCE, 0..2) — `score = 1 -
// distance` maps that back onto this API's original -1..1 range.

import { assertValidIdentifier } from "../persistence/identifiers.ts";

export interface VectorPoint {
  readonly id: string;
  readonly values: number[];
  readonly metadata?: Record<string, unknown>;
}

export interface ScoredVectorPoint extends VectorPoint {
  readonly score: number;
}

export interface VectorCollectionMeta {
  readonly name: string;
  readonly dimension: number;
  readonly createdAt: Date;
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function parseVectorLiteral(raw: string): number[] {
  return raw
    .slice(1, -1)
    .split(",")
    .map((s) => Number(s));
}

export class VectorEngine {
  constructor(private readonly sql: Bun.SQL) {}

  async createCollection(projectId: string, collectionName: string, dimension: number): Promise<VectorCollectionMeta> {
    assertValidIdentifier(collectionName, "collection name");
    if (dimension <= 0 || !Number.isInteger(dimension)) {
      throw new Error(`Invalid dimension: ${dimension}. Must be a positive integer.`);
    }
    const existing = await this.getCollection(projectId, collectionName);
    if (existing) {
      throw new Error(`Vector collection "${collectionName}" already exists in project "${projectId}"`);
    }
    const createdAt = new Date();
    await this.sql`
      INSERT INTO vector_collections (project_id, name, dimension, created_at)
      VALUES (${projectId}, ${collectionName}, ${dimension}, ${createdAt})
    `;
    return { name: collectionName, dimension, createdAt };
  }

  async getCollection(projectId: string, collectionName: string): Promise<VectorCollectionMeta | undefined> {
    const rows = await this.sql<Array<{ dimension: number; created_at: Date }>>`
      SELECT dimension, created_at FROM vector_collections WHERE project_id = ${projectId} AND name = ${collectionName}
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { name: collectionName, dimension: row.dimension, createdAt: new Date(row.created_at) };
  }

  async listCollections(
    projectId: string,
  ): Promise<{ name: string; dimension: number; pointCount: number; createdAt: Date }[]> {
    const rows = await this.sql<Array<{ name: string; dimension: number; created_at: Date }>>`
      SELECT name, dimension, created_at FROM vector_collections WHERE project_id = ${projectId} ORDER BY name
    `;
    const out: { name: string; dimension: number; pointCount: number; createdAt: Date }[] = [];
    for (const r of rows) {
      const countRows = await this.sql<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count FROM vector_points WHERE project_id = ${projectId} AND collection_name = ${r.name}
      `;
      out.push({
        name: r.name,
        dimension: r.dimension,
        pointCount: Number(countRows[0]?.count ?? 0),
        createdAt: new Date(r.created_at),
      });
    }
    return out;
  }

  async dropCollection(projectId: string, collectionName: string): Promise<boolean> {
    const existing = await this.getCollection(projectId, collectionName);
    if (!existing) return false;
    await this.sql`DELETE FROM vector_points WHERE project_id = ${projectId} AND collection_name = ${collectionName}`;
    await this.sql`DELETE FROM vector_collections WHERE project_id = ${projectId} AND name = ${collectionName}`;
    return true;
  }

  async insertVectors(projectId: string, collectionName: string, points: VectorPoint[]): Promise<number> {
    const collection = await this.getCollection(projectId, collectionName);
    if (!collection) throw new Error(`Vector collection "${collectionName}" not found`);

    for (const p of points) {
      if (p.values.length !== collection.dimension) {
        throw new Error(
          `Vector dimension mismatch: expected ${collection.dimension}, got ${p.values.length} for id "${p.id}"`,
        );
      }
      // NOT JSON.stringify — see DatabaseEngine.createTable's comment on
      // why that double-encodes a jsonb column, verified against real
      // Postgres.
      await this.sql`
        INSERT INTO vector_points (project_id, collection_name, point_id, embedding, metadata)
        VALUES (${projectId}, ${collectionName}, ${p.id}, ${toVectorLiteral(p.values)}::vector, ${p.metadata ?? {}}::jsonb)
        ON CONFLICT (project_id, collection_name, point_id)
        DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata
      `;
    }
    return points.length;
  }

  /** Every point in a collection, unranked — used by SnapshotEngine's
   * export (which needs everything, not a similarity ranking) rather than
   * abusing `search` with a synthetic query vector. */
  async listPoints(projectId: string, collectionName: string): Promise<VectorPoint[]> {
    const rows = await this.sql<Array<{ point_id: string; embedding: string; metadata: Record<string, unknown> }>>`
      SELECT point_id, embedding::text AS embedding, metadata FROM vector_points
      WHERE project_id = ${projectId} AND collection_name = ${collectionName}
    `;
    return rows.map((r) => ({ id: r.point_id, values: parseVectorLiteral(r.embedding), metadata: r.metadata }));
  }

  async search(
    projectId: string,
    collectionName: string,
    queryVector: number[],
    topK = 10,
    minScore = -1,
  ): Promise<ScoredVectorPoint[]> {
    const collection = await this.getCollection(projectId, collectionName);
    if (!collection) throw new Error(`Vector collection "${collectionName}" not found`);
    if (queryVector.length !== collection.dimension) {
      throw new Error(`Query vector dimension mismatch: expected ${collection.dimension}, got ${queryVector.length}`);
    }
    const magnitude = Math.sqrt(queryVector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) throw new Error("Query vector cannot be zero-magnitude");

    const literal = toVectorLiteral(queryVector);
    const rows = await this.sql<
      Array<{ point_id: string; embedding: string; metadata: Record<string, unknown>; score: number }>
    >`
      WITH scored AS (
        SELECT point_id, embedding::text AS embedding, metadata, 1 - (embedding <=> ${literal}::vector) AS score
        FROM vector_points
        WHERE project_id = ${projectId} AND collection_name = ${collectionName}
      )
      SELECT * FROM scored WHERE score >= ${minScore} ORDER BY score DESC LIMIT ${topK}
    `;

    return rows.map((r) => ({
      id: r.point_id,
      values: parseVectorLiteral(r.embedding),
      metadata: r.metadata,
      score: Number(r.score),
    }));
  }
}
